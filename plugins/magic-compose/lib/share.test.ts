import { describe, expect, it } from "vitest";
import type { ModelCandidate, Pick, RouteDecision } from "./router";
import {
  applyShare,
  DEFAULT_SHARE_USAGE,
  firstKnownReading,
  gateShare,
  shareBlocked,
  type ShareGate,
  type ShareRule,
  type UsageReading,
  usageReadingFrom,
  type UsageWindow,
} from "./share";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const rule: ShareRule = {
  providerId: "acp-antigravity-acp",
  model: "gemini-4-neon",
  reasoningLevel: "high",
  share: 0.2,
  usage: DEFAULT_SHARE_USAGE,
};

/** A weekly window that is `elapsedFraction` of the way through its 7 days. */
function weekly(used: number, elapsedFraction = 0.5, group = "Gemini Models"): UsageWindow {
  return {
    label: `${group} · Weekly`,
    usedPercent: used,
    resetsAt: new Date(NOW + (1 - elapsedFraction) * 7 * DAY).toISOString(),
  };
}
function fiveHour(used: number, group = "Gemini Models"): UsageWindow {
  return { label: `${group} · 5h`, usedPercent: used, resetsAt: null };
}
const ok = (...windows: UsageWindow[]): UsageReading => ({ status: "ok", windows });

describe("gateShare", () => {
  it("keeps the base odds while the group has headroom", () => {
    expect(gateShare(rule, ok(fiveHour(12), weekly(30)), NOW)).toEqual({
      usage: "headroom",
      odds: 0.2,
      note: "Gemini Models 5h 12%, weekly 30%",
    });
  });

  it("stops at the 5h limit and says which window", () => {
    expect(gateShare(rule, ok(fiveHour(85), weekly(10)), NOW)).toEqual({
      usage: "over",
      odds: 0,
      note: "Gemini Models 5h 85%",
    });
  });

  it("stops at the weekly limit", () => {
    expect(gateShare(rule, ok(fiveHour(1), weekly(90)), NOW)).toEqual({
      usage: "over",
      odds: 0,
      note: "Gemini Models weekly 90%",
    });
  });

  it("draws just under both limits", () => {
    expect(gateShare(rule, ok(fiveHour(84), weekly(89, 0.99)), NOW).usage).toBe("headroom");
  });

  it("scales the odds down by a hot weekly pace", () => {
    const gate = gateShare(rule, ok(fiveHour(10), weekly(75, 0.5)), NOW);
    expect(gate.usage).toBe("scaled");
    expect(gate.odds).toBeCloseTo(0.2 / 1.5);
    expect(gate.note).toContain("weekly pace 1.5×, odds 20% → 13%");
  });

  it("does not read a pace into the first hours of the week", () => {
    const gate = gateShare(rule, ok(fiveHour(1), weekly(3, 0.02)), NOW);
    expect(gate).toMatchObject({ usage: "headroom", odds: 0.2 });
  });

  it("draws at the base odds and says why when usage is unknown", () => {
    const reading: UsageReading = {
      status: "unknown",
      reason: "no reading from usage-pace-antigravity yet",
    };
    expect(gateShare(rule, reading, NOW)).toEqual({
      usage: "unknown",
      odds: 0.2,
      note: "usage unknown: no reading from usage-pace-antigravity yet",
    });
  });

  it("ignores other groups' windows, and is unknown when the group has none", () => {
    const reading = ok(fiveHour(99, "Claude"), weekly(99, 0.5, "Claude"));
    expect(gateShare(rule, reading, NOW)).toMatchObject({ usage: "unknown", odds: 0.2 });
    const both = ok(fiveHour(99, "Claude"), fiveHour(5), weekly(20, 0.5));
    expect(gateShare(rule, both, NOW).usage).toBe("headroom");
  });

  it("lists the groups it saw when none matches, so a renamed group can be fixed", () => {
    const reading = ok(
      fiveHour(10, "Gemini 3P Models"),
      weekly(10, 0.5, "Gemini 3P Models"),
      fiveHour(10, "Claude Models"),
    );
    expect(gateShare(rule, reading, NOW)).toEqual({
      usage: "unknown",
      odds: 0.2,
      note: 'usage unknown: no "Gemini Models" windows in usage-pace-antigravity (saw: Gemini 3P Models, Claude Models)',
    });
    expect(gateShare(rule, ok(), NOW).note).toBe(
      'usage unknown: no "Gemini Models" windows in usage-pace-antigravity',
    );
  });

  it("reads a window's kind in preference to its label's suffix", () => {
    const reading = ok(
      { label: "Gemini Models · Session", usedPercent: 91, resetsAt: null, kind: "five-hour" },
      { label: "Gemini Models · 5h", usedPercent: 5, resetsAt: null, kind: "weekly" },
    );
    expect(gateShare(rule, reading, NOW)).toMatchObject({
      usage: "over",
      note: "Gemini Models 5h 91%",
    });
  });

  it("matches the group name and window kind without regard to case", () => {
    const reading = ok({ label: "gemini models · WEEKLY", usedPercent: 95, resetsAt: null });
    expect(gateShare(rule, reading, NOW)).toMatchObject({ usage: "over" });
  });

  it("applies the window that is present when the other is missing", () => {
    expect(gateShare(rule, ok(fiveHour(90)), NOW)).toMatchObject({ usage: "over" });
    expect(gateShare(rule, ok(weekly(95)), NOW)).toMatchObject({ usage: "over" });
    expect(gateShare(rule, ok(weekly(20)), NOW)).toMatchObject({
      usage: "headroom",
      note: "Gemini Models 5h unknown, weekly 20%",
    });
  });
});

describe("usageReadingFrom", () => {
  it("reads an ok answer's windows, keeping kind and id when the source gives them", () => {
    const reading = usageReadingFrom("usage-pace-antigravity", {
      "usage-pace-antigravity": {
        status: "ok",
        planLabel: "Pro",
        windows: [
          { label: "Gemini Models · 5h", usedPercent: 12, resetsAt: null, kind: "five-hour", id: "gemini-5h" },
          { label: "Gemini Models · Weekly", usedPercent: 30, resetsAt: "2026-11-24T05:00:00Z" },
          { usedPercent: 4 },
        ],
      },
    });
    expect(reading).toEqual({
      status: "ok",
      windows: [
        { label: "Gemini Models · 5h", usedPercent: 12, resetsAt: null, kind: "five-hour", id: "gemini-5h" },
        { label: "Gemini Models · Weekly", usedPercent: 30, resetsAt: "2026-11-24T05:00:00Z" },
      ],
    });
  });

  it("is unknown, never 0%, for a missing or signed-out source", () => {
    expect(usageReadingFrom("usage-pace-antigravity", {})).toEqual({
      status: "unknown",
      reason: "no reading from usage-pace-antigravity yet",
    });
    expect(
      usageReadingFrom("usage-pace-antigravity", { "usage-pace-antigravity": { status: "unauthenticated" } }),
    ).toEqual({ status: "unknown", reason: "usage-pace-antigravity: unauthenticated" });
    expect(
      usageReadingFrom("s", { s: { status: "error", message: "quota endpoint down" } }),
    ).toEqual({ status: "unknown", reason: "s: error: quota endpoint down" });
  });
});

const target: ModelCandidate = {
  providerId: rule.providerId,
  model: rule.model,
  note: "",
  reasoningLevel: "high",
  providerName: "Google Antigravity",
  displayName: "Gemini 4 Neon",
  description: "",
};
const opus: ModelCandidate = {
  providerId: "pi",
  model: "claude-opus-5-5",
  note: "",
  reasoningLevel: "xhigh",
  providerName: "Pi",
  displayName: "Claude Opus 5.5",
  description: "",
};

function picked<T>(value: T, label: string): Pick<T> {
  return {
    value,
    label,
    source: "jev",
    probability: 0.9,
    confidence: 0.8,
    alternatives: [],
    latencyMs: 7,
    inputTokens: 100,
  };
}

function jev(model: ModelCandidate = opus): RouteDecision {
  return {
    project: picked({ id: "proj" } as never, "bb"),
    model: picked(model, `${model.displayName} (${model.providerName})`),
    machine: picked({ id: "host_a" } as never, "devbox"),
    reasoning: picked("xhigh" as const, "xhigh"),
    environment: picked({ id: "git-worktree" } as never, "Worktree"),
    share: null,
    latencyMs: 12,
  };
}

const headroom: ShareGate = { usage: "headroom", odds: 0.2, note: "Gemini Models 5h 12%, weekly 30%" };

function apply(overrides: Partial<Parameters<typeof applyShare>[0]> = {}) {
  return applyShare({
    decision: jev(),
    target,
    base: 0.2,
    gate: headroom,
    blocked: null,
    draw: 0.1,
    ...overrides,
  });
}

describe("applyShare", () => {
  it("swaps in the target's model and effort and keeps where it runs", () => {
    const before = jev();
    const after = apply({ decision: before });
    expect(after.model).toMatchObject({
      value: target,
      label: "Gemini 4 Neon (Google Antigravity)",
      source: "share",
      probability: null,
    });
    expect(after.reasoning).toMatchObject({ value: "high", label: "high", source: "share" });
    expect(after.project).toBe(before.project);
    expect(after.machine).toBe(before.machine);
    expect(after.environment).toBe(before.environment);
    expect(after.share).toMatchObject({
      odds: 0.2,
      usage: "headroom",
      note: headroom.note,
      result: {
        outcome: "drawn",
        draw: 0.1,
        replaced: { model: before.model, reasoning: before.reasoning },
      },
    });
  });

  it("keeps Jev's pick when the draw is at or above the odds", () => {
    const before = jev();
    const after = apply({ decision: before, draw: 0.2 });
    expect(after.model).toBe(before.model);
    expect(after.reasoning).toBe(before.reasoning);
    expect(after.share?.result).toEqual({ outcome: "kept", draw: 0.2 });
  });

  it("does not draw for a target that cannot run on Jev's machine", () => {
    const before = jev();
    const after = apply({ decision: before, blocked: "Google Antigravity is not available on devbox", draw: 0 });
    expect(after.model).toBe(before.model);
    expect(after.share?.result).toEqual({
      outcome: "skipped",
      reason: "Google Antigravity is not available on devbox",
    });
  });

  it("does not draw while usage is over, and says the share was skipped", () => {
    const before = jev();
    const gate: ShareGate = { usage: "over", odds: 0, note: "Gemini Models 5h 91%" };
    const after = apply({ decision: before, gate, draw: 0 });
    expect(after.model).toBe(before.model);
    expect(after.share).toMatchObject({
      usage: "over",
      note: "Gemini Models 5h 91%",
      result: { outcome: "skipped", reason: "share skipped: Gemini Models 5h 91%" },
    });
  });

  it("does not draw when Jev already picked the target", () => {
    const before = jev(target);
    const after = apply({ decision: before, draw: 0 });
    expect(after.model).toBe(before.model);
    expect(after.share?.result).toEqual({
      outcome: "skipped",
      reason: "Jev picked Gemini 4 Neon (Google Antigravity) itself",
    });
  });

  it("lands exactly the configured share over evenly spaced draws", () => {
    const count = (gate: ShareGate) => {
      let drawn = 0;
      for (let i = 0; i < 10_000; i++) {
        const result = apply({ gate, draw: i / 10_000 }).share?.result;
        if (result?.outcome === "drawn") drawn++;
      }
      return drawn;
    };
    expect(count(gateShare(rule, ok(fiveHour(10), weekly(20, 0.5)), NOW))).toBe(2_000);
    // A quarter of the week gone and half the quota used: pace 2.
    expect(count(gateShare(rule, ok(fiveHour(10), weekly(50, 0.25)), NOW))).toBe(1_000);
  });
});

describe("shareBlocked", () => {
  const mac = { name: "scott-macbook-m3" };
  const listed = new Map([[target.providerId, true]]);
  const neonListed = { modelLoadError: null, models: [{ model: target.model }] };

  it("lets the target run where its provider is available and lists the model", () => {
    expect(shareBlocked(target, mac, listed, neonListed)).toBeNull();
  });

  it("blocks a machine where the provider is listed but its agent cannot start", () => {
    // What bb reports for an ACP agent whose binary is missing on that machine.
    const missing = { modelLoadError: { code: "missing_executable" }, models: [] };
    expect(shareBlocked(target, mac, listed, missing)).toBe(
      "Google Antigravity cannot start on scott-macbook-m3 (missing_executable)",
    );
  });

  it("blocks a machine where the provider is unavailable or its providers could not be read", () => {
    expect(shareBlocked(target, mac, new Map([[target.providerId, false]]), neonListed)).toBe(
      "Google Antigravity is not available on scott-macbook-m3",
    );
    expect(shareBlocked(target, mac, new Map(), neonListed)).toBe(
      "Google Antigravity is not available on scott-macbook-m3",
    );
    expect(shareBlocked(target, mac, null, neonListed)).toBe(
      "could not check Google Antigravity on scott-macbook-m3",
    );
  });

  it("blocks when the model list is missing, late, or lacks the model", () => {
    expect(shareBlocked(target, mac, listed, null)).toBe(
      "could not list Google Antigravity's models on scott-macbook-m3",
    );
    expect(shareBlocked(target, mac, listed, undefined)).toBe(
      "Google Antigravity on scott-macbook-m3 did not list its models in time",
    );
    expect(
      shareBlocked(target, mac, listed, { modelLoadError: null, models: [{ model: "gemini-4-argon" }] }),
    ).toBe("Google Antigravity does not list gemini-4-neon on scott-macbook-m3");
  });
});

describe("gateShare with an old reading", () => {
  it("says how old a reading is once it is past a few minutes", () => {
    const read = (ago: number, windows = [fiveHour(12), weekly(30)]): UsageReading => ({
      status: "ok",
      windows,
      readAt: NOW - ago,
    });
    expect(gateShare(rule, read(2 * 60_000), NOW).note).toBe("Gemini Models 5h 12%, weekly 30%");
    expect(gateShare(rule, read(40 * 60_000), NOW).note).toBe(
      "Gemini Models 5h 12%, weekly 30% · read 40 min ago",
    );
    expect(gateShare(rule, read(6 * 60 * 60_000, [fiveHour(91)]), NOW).note).toBe(
      "Gemini Models 5h 91% · read 6 h ago",
    );
  });

  const resetAt = (window: UsageWindow, at: number): UsageWindow => ({
    ...window,
    resetsAt: new Date(at).toISOString(),
  });

  it("leaves out a 5h window that has reset since it was read", () => {
    const gate = gateShare(rule, ok(resetAt(fiveHour(95), NOW - 60_000), weekly(30)), NOW);
    expect(gate.usage).toBe("headroom");
    expect(gate.odds).toBe(0.2);
    expect(gate.note).toBe("Gemini Models 5h unknown, weekly 30%");
  });

  it("still stops at a 5h window that has not reset yet", () => {
    const gate = gateShare(rule, ok(resetAt(fiveHour(95), NOW + 60_000), weekly(30)), NOW);
    expect(gate.usage).toBe("over");
  });

  it("is unknown at the base odds when every window of the group has reset", () => {
    const gate = gateShare(
      rule,
      ok(resetAt(fiveHour(95), NOW - 60_000), resetAt(weekly(95), NOW - 60_000)),
      NOW,
    );
    expect(gate).toEqual({
      usage: "unknown",
      odds: 0.2,
      note: 'usage unknown: "Gemini Models" has reset since the last reading',
    });
  });
});

describe("firstKnownReading", () => {
  it("takes another machine's good reading over an empty one on the thread's machine", () => {
    const empty: UsageReading = { status: "unknown", reason: "no reading from usage-pace-antigravity yet" };
    const full = ok(fiveHour(91), weekly(30, 0.5));
    expect(gateShare(rule, firstKnownReading([empty, full]), NOW).usage).toBe("over");
  });

  it("takes the newest good reading, the thread's machine on a tie", () => {
    const stale: UsageReading = { status: "ok", windows: [fiveHour(10), weekly(30)], readAt: NOW - 6 * 60 * 60_000 };
    const fresh: UsageReading = { status: "ok", windows: [fiveHour(10), weekly(95)], readAt: NOW - 60_000 };
    expect(gateShare(rule, firstKnownReading([stale, fresh]), NOW).usage).toBe("over");
    const twin: UsageReading = { ...stale };
    expect(firstKnownReading([stale, twin])).toBe(stale);
  });

  it("keeps the thread machine's reason when no machine has a reading", () => {
    const first: UsageReading = { status: "unknown", reason: "usage-pace-antigravity: unauthenticated" };
    const second: UsageReading = { status: "unknown", reason: "no reading from usage-pace-antigravity yet" };
    expect(firstKnownReading([first, second])).toBe(first);
  });
});
