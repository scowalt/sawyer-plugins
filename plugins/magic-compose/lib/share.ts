// The random share: after Jev picks, a configured fraction of new threads goes
// to one share target instead, so the user can compare it with the rotation on
// real work. The share follows the target's quota group: it stops when the
// group is nearly used up and thins out when the week is running hot. Pure
// logic; server.ts reads the usage and the machines, and draws the number.
import { z } from "zod";
import type { ModelCandidate, Pick as RoutePick, RouteDecision } from "./router";
import type { ReasoningLevel } from "./reasoning";

export interface ShareUsageRule {
  /** Provider-usage source id read through bb.sdk.system.usageLimits, e.g. "usage-pace-antigravity". */
  sourceId: string;
  /** The quota group the target counts against, as the source names it, e.g. "Gemini Models". */
  group: string;
  /** No draw while the group's 5-hour window is at or above this percent. */
  maxSessionPercent: number;
  /** No draw while the group's weekly window is at or above this percent. */
  maxWeeklyPercent: number;
}

export interface ShareRule {
  providerId: string;
  model: string;
  /** The effort a drawn thread runs at. Jev's effort pick is not used. */
  reasoningLevel: ReasoningLevel;
  /** Fraction of eligible new threads drawn for the target, 0..1. */
  share: number;
  usage: ShareUsageRule;
}

export const DEFAULT_SHARE_USAGE: ShareUsageRule = {
  sourceId: "usage-pace-antigravity",
  group: "Gemini Models",
  maxSessionPercent: 85,
  maxWeeklyPercent: 90,
};

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  /** What the source says the window is, when it says. Preferred over the label's suffix. */
  kind?: "five-hour" | "weekly";
  /** The source's own bucket id, such as "gemini-5h". */
  id?: string;
}

export type UsageReading =
  | { status: "ok"; windows: readonly UsageWindow[] }
  | { status: "unknown"; reason: string };

const usageWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable().catch(null),
  kind: z.enum(["five-hour", "weekly"]).optional().catch(undefined),
  id: z.string().optional().catch(undefined),
});

/**
 * What `bb.sdk.system.usageLimits` said about `sourceId`, as a reading. Anything
 * but an ok answer is unknown, never 0%: a source that is missing or signed out
 * has not said the group has headroom.
 */
export function usageReadingFrom(
  sourceId: string,
  response: Record<string, unknown>,
): UsageReading {
  const entry = response[sourceId];
  if (typeof entry !== "object" || entry === null) {
    return { status: "unknown", reason: `no reading from ${sourceId} yet` };
  }
  const { status, message, windows } = entry as Record<string, unknown>;
  if (status !== "ok") {
    const detail = typeof message === "string" && message !== "" ? `: ${message}` : "";
    return { status: "unknown", reason: `${sourceId}: ${String(status)}${detail}` };
  }
  return {
    status: "ok",
    windows: (Array.isArray(windows) ? windows : []).flatMap((window) => {
      const parsed = usageWindowSchema.safeParse(window);
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

export type ShareUsageState = "headroom" | "scaled" | "unknown" | "over";

export interface ShareGate {
  usage: ShareUsageState;
  /** The chance a draw lands, after usage: base, base/pace, or 0 when over. */
  odds: number;
  /** Plain words for the decision. */
  note: string;
}

export type ShareResult =
  /** No draw: usage over, the target cannot run there, or Jev already picked it. */
  | { outcome: "skipped"; reason: string }
  /** Drew at or above the odds: Jev's pick stands. */
  | { outcome: "kept"; draw: number }
  | {
      outcome: "drawn";
      draw: number;
      replaced: { model: RoutePick<ModelCandidate>; reasoning: RoutePick<ReasoningLevel> };
    };

export interface ShareDecision {
  /** Display names from the catalog; reasoningLevel is the rule's. */
  target: ModelCandidate;
  base: number;
  odds: number;
  usage: ShareUsageState;
  /** The gate's words, or the reason nothing was drawn. */
  note: string;
  result: ShareResult;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LABEL_SEPARATOR = " · ";

type WindowKind = "5h" | "weekly";

/** A window's group name and kind. Labels are `<group name> · 5h` or `<group name> · Weekly`. */
function describeWindow(window: UsageWindow): { name: string; kind: string } {
  const at = window.label.lastIndexOf(LABEL_SEPARATOR);
  const name = (at < 0 ? window.label : window.label.slice(0, at)).trim();
  const suffix = at < 0 ? "" : window.label.slice(at + LABEL_SEPARATOR.length).trim().toLowerCase();
  const kind = window.kind === undefined ? suffix : window.kind === "five-hour" ? "5h" : window.kind;
  return { name, kind };
}

/** The one place a window label is read. */
function groupWindow(
  windows: readonly UsageWindow[],
  group: string,
  kind: WindowKind,
): UsageWindow | null {
  const wanted = group.trim().toLowerCase();
  return (
    windows.find((window) => {
      const described = describeWindow(window);
      return described.name.toLowerCase() === wanted && described.kind === kind;
    }) ?? null
  );
}

/** The group names a reading carries, for telling the user what to set when none matches. */
function groupNames(windows: readonly UsageWindow[]): string[] {
  return [...new Set(windows.map((window) => describeWindow(window).name))];
}

/** Used over elapsed, for a 7-day window ending at `resetsAt`. Null while it is too early to say. */
function weeklyPace(window: UsageWindow, now: number): number | null {
  if (window.resetsAt === null) return null;
  const resetsAt = Date.parse(window.resetsAt);
  if (Number.isNaN(resetsAt)) return null;
  const elapsed = Math.min(1, (WEEK_MS - (resetsAt - now)) / WEEK_MS);
  if (elapsed <= 0) return null;
  if (elapsed < 0.05 && window.usedPercent < 5) return null;
  return window.usedPercent / (elapsed * 100);
}

const percent = (value: number) => `${Math.round(value)}%`;
const oddsPercent = (value: number) => `${Math.round(value * 100)}%`;

export function gateShare(rule: ShareRule, reading: UsageReading, now: number): ShareGate {
  const base = rule.share;
  if (reading.status === "unknown") {
    return { usage: "unknown", odds: base, note: `usage unknown: ${reading.reason}` };
  }
  const { group, maxSessionPercent, maxWeeklyPercent } = rule.usage;
  const session = groupWindow(reading.windows, group, "5h");
  const weekly = groupWindow(reading.windows, group, "weekly");
  if (session === null && weekly === null) {
    const seen = groupNames(reading.windows);
    return {
      usage: "unknown",
      odds: base,
      note: `usage unknown: no "${group}" windows in ${rule.usage.sourceId}${seen.length === 0 ? "" : ` (saw: ${seen.join(", ")})`}`,
    };
  }
  if (session !== null && session.usedPercent >= maxSessionPercent) {
    return { usage: "over", odds: 0, note: `${group} 5h ${percent(session.usedPercent)}` };
  }
  if (weekly !== null && weekly.usedPercent >= maxWeeklyPercent) {
    return { usage: "over", odds: 0, note: `${group} weekly ${percent(weekly.usedPercent)}` };
  }
  const used =
    `${group} 5h ${session === null ? "unknown" : percent(session.usedPercent)}, ` +
    `weekly ${weekly === null ? "unknown" : percent(weekly.usedPercent)}`;
  const pace = weekly === null ? null : weeklyPace(weekly, now);
  if (pace !== null && pace > 1) {
    const odds = base / pace;
    return {
      usage: "scaled",
      odds,
      note: `${used} · weekly pace ${pace.toFixed(1)}×, odds ${oddsPercent(base)} → ${oddsPercent(odds)}`,
    };
  }
  return { usage: "headroom", odds: base, note: used };
}

/** What a provider's model list on one machine says, as far as the share needs it. */
export interface TargetCatalog {
  /** Set when the provider could not start there, e.g. `missing_executable` where its agent is not installed. */
  modelLoadError: { code: string } | null;
  models: readonly { model: string }[];
}

/**
 * Why the share target cannot run on `machine`, or null when it can. Stricter
 * than Jev's own machine filter: a provider list or model list that could not
 * be read blocks. `providers` is null when the machine's providers could not be
 * read; `catalog` is undefined when its model list did not arrive in time and
 * null when it could not be read.
 */
export function shareBlocked(
  target: ModelCandidate,
  machine: { name: string },
  providers: ReadonlyMap<string, boolean> | null | undefined,
  catalog: TargetCatalog | null | undefined,
): string | null {
  const { providerName } = target;
  if (providers === null || providers === undefined) {
    return `could not check ${providerName} on ${machine.name}`;
  }
  if (providers.get(target.providerId) !== true) {
    return `${providerName} is not available on ${machine.name}`;
  }
  if (catalog === undefined) return `${providerName} on ${machine.name} did not list its models in time`;
  if (catalog === null) return `could not list ${providerName}'s models on ${machine.name}`;
  if (catalog.modelLoadError !== null) {
    return `${providerName} cannot start on ${machine.name} (${catalog.modelLoadError.code})`;
  }
  if (!catalog.models.some((candidate) => candidate.model === target.model)) {
    return `${providerName} does not list ${target.model} on ${machine.name}`;
  }
  return null;
}

/** Jev's decision, or the share target in place of its model and effort when `draw` lands. */
export function applyShare(args: {
  /** Jev's decision, with `share` null. */
  decision: RouteDecision;
  target: ModelCandidate;
  base: number;
  gate: ShareGate;
  /** Why the target cannot run on Jev's machine, or null when it can. */
  blocked: string | null;
  /** Uniform in [0, 1). Injected so tests are deterministic. */
  draw: number;
}): RouteDecision {
  const { decision, target, base, gate, blocked, draw } = args;
  const shown = { target, base, odds: gate.odds, usage: gate.usage };
  const picked = decision.model.value;
  const label = `${target.displayName} (${target.providerName})`;

  const skip = (note: string, reason = note): RouteDecision => ({
    ...decision,
    share: { ...shown, note, result: { outcome: "skipped", reason } },
  });
  if (picked.providerId === target.providerId && picked.model === target.model) {
    return skip(`Jev picked ${label} itself`);
  }
  if (blocked !== null) return skip(blocked);
  if (gate.usage === "over") return skip(gate.note, `share skipped: ${gate.note}`);
  if (draw >= gate.odds) {
    return { ...decision, share: { ...shown, note: gate.note, result: { outcome: "kept", draw } } };
  }

  const pick = <T>(value: T, name: string): RoutePick<T> => ({
    value,
    label: name,
    source: "share",
    probability: null,
    confidence: null,
    alternatives: [],
    latencyMs: 0,
    inputTokens: null,
  });
  return {
    ...decision,
    model: pick(target, label),
    reasoning: pick(target.reasoningLevel, target.reasoningLevel),
    share: {
      ...shown,
      note: gate.note,
      result: {
        outcome: "drawn",
        draw,
        replaced: { model: decision.model, reasoning: decision.reasoning },
      },
    },
  };
}
