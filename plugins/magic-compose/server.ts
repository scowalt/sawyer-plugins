// Magic Compose: route a new-thread prompt to a project, machine, and
// environment with Jev (TypeSafe's classifier) on the Vercel AI Gateway,
// OpenRouter, or OpenCode, then start the thread there. The model and effort
// are not chosen here: bb's model autopilot (Usage Pace) picks them. app.tsx
// owns the composer toggle; this file gathers the candidates, asks Jev, and spawns.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, machineStatsSchema } from "./contract";
import {
  askChoicesVia,
  JEV_PROVIDERS,
  JevError,
  warmRoutes,
  type JevProvider,
  type JevRoute,
} from "./lib/jev";
import { jevTransport } from "./lib/transport";
import { SwrCache } from "./lib/cache";
import { formatSpans, Profiler } from "./lib/profile";
import {
  DEFAULT_PREFERENCES,
  PERMISSION_MODES,
  type Preferences,
  preferencesPatchSchema,
  preferencesSchema,
  readStoredPreferences,
} from "./lib/preferences";
import {
  describeMachine,
  route,
  RouteError,
  type MachineCandidate,
  type MachineStats,
  type Pick,
  type ProjectCandidate,
  type RouteDecision,
  type Targets,
} from "./lib/router";

const SCOPE_KEY = "scope";
const PREFERENCES_KEY = "preferences";
/** Kept by versions that picked the model; nothing reads them now. */
const RETIRED_KEYS = ["rotation", "share", "shareDraws"];
const RECENT_TITLES_PER_PROJECT = 4;
const STATS_TIMEOUT_MS = 2_500;
const STATS_FRESH_MS = 15_000;
/** Which machines hold a project, and what each can create, rarely change. */
const AVAILABILITY_FRESH_MS = 30_000;
/** How old a cached fact may be and still be served while a refresh runs behind it. */
const SERVE_STALE_MS = 10 * 60_000;
/**
 * How long a dispatch waits for a machine to describe itself when nothing is
 * cached, as just after BB starts. Past this it routes without that detail;
 * the answer still lands in the cache for next time.
 */
const FACT_WAIT_MS = 350;
/** A fresh worktree per thread, unless the user picks otherwise. */
const DEFAULT_ENVIRONMENTS = ["git-worktree"];
/** Works for any project with a folder, so it backs up environments that need git. */
const FALLBACK_ENVIRONMENT = "project-checkout";
/** `auto` uses every key that is set, in this order: each backs up the ones before it. */
const JEV_PROVIDERS_IN_AUTO_ORDER = [
  "vercel",
  "openrouter",
  "opencode",
] as const satisfies readonly JevProvider[];
const JEV_PROVIDER_CHOICES = ["auto", ...JEV_PROVIDERS_IN_AUTO_ORDER] as const;

/** The provider the Jev provider setting names, or undefined for `auto`. */
function chosenJevProvider(setting: string): JevProvider | undefined {
  return JEV_PROVIDERS_IN_AUTO_ORDER.find((provider) => provider === setting);
}


type PermissionMode = (typeof PERMISSION_MODES)[number];

// Which projects and environments Magic Compose may choose between.
const scopeSchema = z
  .object({
    /** True offers every project, including ones added later and "No project". */
    allProjects: z.boolean(),
    /** Offered when `allProjects` is false. The personal project's id means "No project". */
    projectIds: z.array(z.string().min(1).max(200)).max(1_000),
    /** Environment provider ids, in order of preference. */
    environmentIds: z.array(z.string().min(1).max(64)).max(32),
  })
  .strict();
type Scope = z.infer<typeof scopeSchema>;
// No field here may carry a default: a default would be filled in for every
// field a partial save leaves out, and overwrite what the user had chosen.
const scopePatchSchema = scopeSchema.partial();
// A stored scope may carry fields since removed, such as the effort levels; reading drops them.
const storedScopeSchema = z.object(scopeSchema.shape);
const DEFAULT_SCOPE: Scope = {
  allProjects: true,
  projectIds: [],
  environmentIds: DEFAULT_ENVIRONMENTS,
};

const pickSchema = z
  .object({
    label: z.string(),
    source: z.enum(["jev", "only-option", "fallback"]),
    probability: z.number().nullable(),
    confidence: z.number().nullable(),
    alternatives: z.array(z.object({ label: z.string(), probability: z.number() }).strict()),
  })
  .strict();

const decisionSchema = z
  .object({
    project: pickSchema.extend({ id: z.string() }),
    machine: pickSchema.extend({ id: z.string() }),
    environment: pickSchema.extend({ id: z.string() }),
    latencyMs: z.number(),
    /** Where the time went; overlapping spans ran in parallel. */
    timings: z.array(
      z.object({ name: z.string(), startMs: z.number(), endMs: z.number() }).strict(),
    ),
  })
  .strict();
export type DecisionSummary = z.infer<typeof decisionSchema>;

const promptSchema = z.string().trim().min(1).max(200_000);

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z
      .object({
        hasApiKey: z.boolean(),
        /** The gateways a question goes to, in the order they are tried. */
        gateways: z.array(z.string()),
        /** The last time Jev was asked, since the plugin loaded. */
        last: z
          .object({
            at: z.number(),
            latencyMs: z.number().nullable(),
            error: z.string().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  },
  preferences_get: {
    input: z.null(),
    output: z.object({ preferences: preferencesSchema }).strict(),
  },
  /** Merges into the stored preferences, so each settings section saves only its own fields. */
  preferences_set: {
    input: z.object({ preferences: preferencesPatchSchema }).strict(),
    output: z.object({ preferences: preferencesSchema }).strict(),
  },
  /** What Jev is told about each connected machine. */
  machines: {
    input: z.null(),
    output: z
      .object({
        machines: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              description: z.string(),
              stats: machineStatsSchema.nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  /**
   * Get ready for a dispatch while the user is still typing: open the
   * connection to Jev and refresh the facts about machines and projects.
   */
  warm: {
    input: z.null(),
    output: z.object({ warmed: z.boolean() }).strict(),
  },
  /** The scope, plus every project and environment it could include. */
  scope_get: {
    input: z.null(),
    output: z
      .object({
        scope: scopeSchema,
        projects: z.array(
          z.object({ id: z.string(), name: z.string(), detail: z.string() }).strict(),
        ),
        environments: z.array(
          z.object({ id: z.string(), name: z.string(), detail: z.string() }).strict(),
        ),
      })
      .strict(),
  },
  /** Merges into the stored scope, so each settings section saves only its own fields. */
  scope_set: {
    input: z.object({ scope: scopePatchSchema }).strict(),
    output: z.object({ scope: scopeSchema }).strict(),
  },
  /** Ask Jev where a prompt would go without starting anything. */
  preview: {
    input: z
      .object({
        text: promptSchema,
        /** Route within this project only, for a composer whose project Magic Compose may not set. */
        projectId: z.string().min(1).nullable().default(null),
      })
      .strict(),
    output: z.object({ decision: decisionSchema }).strict(),
  },
});

/** What the Projects and Environments settings sections render. */
export type ScopeOptions = z.infer<(typeof rpcContract)["scope_get"]["output"]>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  return work(AbortSignal.timeout(ms));
}

/** `work`'s answer, or `fallback` if it has not arrived within `ms`. The work carries on. */
function within<T>(ms: number, work: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function summarizePick<T>(pick: Pick<T>): z.infer<typeof pickSchema> {
  return {
    label: pick.label,
    source: pick.source,
    probability: pick.probability,
    confidence: pick.confidence,
    alternatives: pick.alternatives,
  };
}

function formatPercent(value: number | null): string {
  return value === null ? "" : ` ${Math.round(value * 100)}%`;
}

function formatDecision(decision: DecisionSummary): string {
  const line = (title: string, pick: z.infer<typeof pickSchema>) => {
    const how =
      pick.source === "only-option"
        ? " (only option)"
        : `${formatPercent(pick.probability)}${pick.source === "fallback" ? " (fallback)" : ""}`;
    const others = pick.alternatives
      .filter((alternative) => alternative.probability >= 0.05)
      .map((alternative) => `${alternative.label}${formatPercent(alternative.probability)}`)
      .join(", ");
    return `${title.padEnd(12)}${pick.label}${how}${others === "" ? "" : `   also: ${others}`}`;
  };
  return [
    line("Project", decision.project),
    line("Machine", decision.machine),
    line("Environment", decision.environment),
    `Decided in ${decision.latencyMs}ms`,
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    gatewayApiKey: {
      type: "string",
      label: "Vercel AI Gateway API key",
      description:
        "One way to reach Jev; set this, an OpenRouter key, an OpenCode key, or several. Create one in the Vercel dashboard under AI Gateway → API keys. The free tier allows only about 10 Jev calls per 5 minutes; any Gateway credit lifts that.",
      secret: true,
    },
    openRouterApiKey: {
      type: "string",
      label: "OpenRouter API key",
      description:
        "Another way to reach Jev (typesafe/jev-1.13). Create one at https://openrouter.ai/keys.",
      secret: true,
    },
    openCodeApiKey: {
      type: "string",
      label: "OpenCode API key",
      description:
        "Another way to reach Jev, with the key from an OpenCode Go or pay-as-you-go account. It uses jev-1.13-free, which OpenCode offers free for a limited time; switch the OpenCode model id under Advanced to jev-1.13 to pay from your OpenCode balance. Find the key at https://opencode.ai/console.",
      secret: true,
    },
    jevProvider: {
      type: "select",
      label: "Jev provider",
      description:
        "Which key to route with. “auto” uses whichever keys are set, asking the Vercel AI Gateway first, then OpenRouter, then OpenCode, each only if the one before fails.",
      options: [...JEV_PROVIDER_CHOICES],
      default: "auto",
    },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });
  void Promise.all(RETIRED_KEYS.map(key => bb.storage.kv.delete(key))).catch((error: unknown) => {
    bb.log.warn(`Magic Compose could not clear its retired settings: ${error instanceof Error ? error.message : String(error)}`);
  });
  // The warm connections to Jev belong to this load of the plugin.
  bb.onDispose(() => jevTransport.close());

  async function readPreferences(): Promise<Preferences> {
    return readStoredPreferences(await bb.storage.kv.get(PREFERENCES_KEY));
  }

  async function writePreferences(patch: Partial<Preferences>): Promise<Preferences> {
    const next = preferencesSchema.parse({ ...(await readPreferences()), ...patch });
    await bb.storage.kv.set(PREFERENCES_KEY, next);
    return next;
  }

  /** The declared settings and the preferences, as the one configuration they are. */
  async function readConfig() {
    const [connection, preferences] = await Promise.all([settings.get(), readPreferences()]);
    return { ...connection, ...preferences };
  }

  async function readScope(): Promise<Scope> {
    const parsed = storedScopeSchema.safeParse(await bb.storage.kv.get(SCOPE_KEY));
    if (!parsed.success) return DEFAULT_SCOPE;
    // Magic Compose always needs somewhere to run.
    return {
      ...parsed.data,
      environmentIds:
        parsed.data.environmentIds.length === 0 ? DEFAULT_ENVIRONMENTS : parsed.data.environmentIds,
    };
  }

  /** The ways to reach Jev that are set up, in the order to try them. */
  async function jevRoutes(): Promise<JevRoute[]> {
    const config = await readConfig();
    const secret = (value: unknown) =>
      typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    const keys: Record<JevProvider, string | null> = {
      vercel: secret(config.gatewayApiKey),
      openrouter: secret(config.openRouterApiKey),
      opencode: secret(config.openCodeApiKey),
    };
    const models: Record<JevProvider, string> = {
      vercel: config.jevModel,
      openrouter: config.openRouterJevModel,
      opencode: config.openCodeJevModel,
    };
    const chosen = chosenJevProvider(config.jevProvider);
    const order = chosen === undefined ? JEV_PROVIDERS_IN_AUTO_ORDER : [chosen];
    return order.flatMap((provider): JevRoute[] => {
      const apiKey = keys[provider];
      return apiKey === null ? [] : [{ provider, apiKey, model: models[provider] }];
    });
  }

  type EnvironmentProvider = Awaited<
    ReturnType<typeof bb.sdk.environments.listProviders>
  >[number];

  // A dispatch reads these through caches, so it never waits on a machine
  // that is slow to answer. `warm` fills them while the user is still typing.
  const statsCache = new SwrCache<MachineStats>(
    (hostId) =>
      withTimeout((signal) => host.call("stats", null, { hostId, signal }), STATS_TIMEOUT_MS),
    STATS_FRESH_MS,
    SERVE_STALE_MS,
  );
  const environmentsCache = new SwrCache<EnvironmentProvider[]>(
    (projectId) => bb.sdk.environments.listProviders({ projectId }),
    AVAILABILITY_FRESH_MS,
    SERVE_STALE_MS,
  );

  async function machineStats(hostId: string): Promise<MachineStats | null> {
    try {
      return await statsCache.get(hostId);
    } catch (error) {
      bb.log.warn(`machine stats unavailable for ${hostId}: ${messageOf(error)}`);
      return null;
    }
  }

  /** The connected machines, with how many threads each is running right now. */
  async function loadMachines() {
    const [hosts, systemConfig, running] = await Promise.all([
      bb.sdk.hosts.list(),
      bb.sdk.system.config(),
      bb.sdk.threads.count({ groupBy: "host", status: "active" }),
    ]);
    const runningByHost = new Map(
      (running.groups ?? []).map((group) => [group.key, group.count] as const),
    );
    const connected = hosts.filter(
      (entry) => entry.status === "connected" && entry.lifecycle.phase === "active",
    );
    const candidate = (
      entry: (typeof hosts)[number],
      stats: MachineStats | null,
      projectPath: string | null,
      environmentIds: string[],
    ): MachineCandidate => ({
      id: entry.id,
      name: entry.name,
      isServer: entry.id === systemConfig.primaryHostId,
      stats,
      runningThreads: runningByHost.get(entry.id) ?? 0,
      projectPath,
      environmentIds,
    });
    return { hosts, connected, candidate };
  }

  async function loadProjects(scope: Scope): Promise<ProjectCandidate[]> {
    const projects = await bb.sdk.projects.list({ includePersonal: true, include: "threads" });
    const candidates: ProjectCandidate[] = [];
    for (const project of projects) {
      const isPersonal = project.kind === "personal";
      if (!scope.allProjects && !scope.projectIds.includes(project.id)) continue;
      const threads = "threads" in project ? project.threads : [];
      candidates.push({
        id: project.id,
        name: project.name,
        isPersonal,
        gitRemoteUrl: project.gitRemoteUrl,
        sources: project.sources.map((source) => ({ hostId: source.hostId, path: source.path })),
        recentThreadTitles: threads
          .filter((thread) => thread.archivedAt === null)
          .map((thread) => (thread.title ?? thread.titleFallback ?? "").trim().slice(0, 80))
          .filter((title) => title !== "")
          .slice(0, RECENT_TITLES_PER_PROJECT),
      });
    }
    return candidates;
  }

  interface RoutedThread {
    decision: RouteDecision;
    profiler: Profiler;
    /** Null for a provider that declares no inputs, else its all-defaults inputs. */
    environmentInputs: Record<string, never> | null;
    permissionMode: PermissionMode;
  }

  /** Providers Magic Compose can fill in by itself: no new machine, no inputs only a person can give. */
  function isAutomatic(provider: EnvironmentProvider): boolean {
    return (
      provider.machineProviderId === null && (provider.inputs === null || provider.acceptsEmptyInputs)
    );
  }

  /** How the last question to Jev went, for the settings page. Not kept across loads. */
  let lastAsked: { at: number; latencyMs: number | null; error: string | null } | null = null;

  /**
   * Decide where `text` should run. With `projectId`, within that project
   * only, whether or not it is one Magic Compose may choose: that is for a composer
   * whose project Magic Compose has been told to leave alone.
   */
  async function decide(
    text: string,
    options: { projectId?: string | null } = {},
  ): Promise<RoutedThread> {
    try {
      const routed = await decideWithin(text, options.projectId ?? null);
      lastAsked = { at: Date.now(), latencyMs: routed.profiler.elapsed(), error: null };
      return routed;
    } catch (error) {
      lastAsked = { at: Date.now(), latencyMs: null, error: messageOf(error) };
      throw error;
    }
  }

  async function decideWithin(text: string, projectId: string | null): Promise<RoutedThread> {
    const profiler = new Profiler();
    const config = await profiler.time("settings", () => readConfig());
    const routes = await profiler.time("settings.keys", () => jevRoutes());
    if (routes.length === 0) {
      const chosen = chosenJevProvider(config.jevProvider);
      throw new RouteError(
        chosen === undefined
          ? "Add a Vercel AI Gateway, OpenRouter, or OpenCode API key in Magic Compose settings first."
          : `Add your ${JEV_PROVIDERS[chosen].name} API key in Magic Compose settings, or set the Jev provider to auto.`,
      );
    }
    const scope = await profiler.time("kv.scope", () => readScope());
    const [projects, { hosts, connected, candidate }] = await Promise.all([
      profiler.time("load.projects", async () =>
        projectId === null
          ? loadProjects(scope)
          : (await loadProjects({ ...scope, allProjects: true })).filter(
              (project) => project.id === projectId,
            ),
      ),
      profiler.time("load.machines", () => loadMachines()),
    ]);
    if (connected.length === 0) throw new RouteError("No machine is connected.");
    // A project checked out only on machines that are offline cannot run
    // anywhere right now, so it is not worth offering.
    const online = new Set(connected.map((entry) => entry.id));
    const reachable = projects.filter(
      (project) => project.isPersonal || project.sources.some((source) => online.has(source.hostId)),
    );
    if (reachable.length === 0) {
      throw new RouteError(
        projectId !== null
          ? "The composer's project is not on a connected machine."
          : projects.length === 0
            ? "Pick at least one project for Magic Compose in Magic Compose settings."
            : "None of the projects Magic Compose may use is on a connected machine.",
      );
    }
    // Everything code must know before Jev is asked anything: what each
    // machine is doing and which environments it can create for each project. All cached, all fetched side by side.
    const [statsByHost, environmentsByProject] = await Promise.all([
      profiler.time("facts.machineStats", async () =>
        new Map(
          await Promise.all(
            connected.map(
              async (entry) =>
                [entry.id, await within(FACT_WAIT_MS, machineStats(entry.id), null)] as const,
            ),
          ),
        ),
      ),
      profiler.time("facts.environments", async () =>
        new Map(
          await Promise.all(
            reachable.map(
              async (project) => [project.id, await environmentsCache.get(project.id)] as const,
            ),
          ),
        ),
      ),
    ]);

    let permissionMode: PermissionMode =
      PERMISSION_MODES.find((mode) => mode === config.permissionMode) ?? "auto";

    interface TargetDetail extends Targets {
      usedFallback: boolean;
      inputs: Map<string, RoutedThread["environmentInputs"]>;
    }
    const targetDetails = new Map<string, TargetDetail>();
    /** Where `project` can run, from the facts above. No I/O. */
    function targetsFor(project: ProjectCandidate): TargetDetail {
      const cached = targetDetails.get(project.id);
      if (cached !== undefined) return cached;

      const usable = (environmentsByProject.get(project.id) ?? []).filter(
        (provider) => provider.requires.projectless === project.isPersonal && isAutomatic(provider),
      );
      // The environments the user allowed, in their order. A projectless
      // thread takes whichever projectless provider is installed. A project
      // none of them can serve (not a git repository, say) still gets a
      // plain checkout rather than no thread.
      const chosen = project.isPersonal
        ? usable
        : scope.environmentIds.flatMap((id) => usable.filter((provider) => provider.id === id));
      const fallback = usable.filter(
        (provider) => provider.id === FALLBACK_ENVIRONMENT && !chosen.includes(provider),
      );
      let detail: TargetDetail = {
        machines: [],
        environments: [],
        usedFallback: false,
        inputs: new Map(),
      };
      for (const tier of [chosen, fallback]) {
        const environmentsByMachine = new Map<string, string[]>();
        for (const provider of tier) {
          const anyMachine =
            project.isPersonal && Object.keys(provider.machineAvailability).length === 0;
          for (const entry of connected) {
            if (!anyMachine && provider.machineAvailability[entry.id]?.status !== "available") {
              continue;
            }
            environmentsByMachine.set(entry.id, [
              ...(environmentsByMachine.get(entry.id) ?? []),
              provider.id,
            ]);
          }
        }
        const runnable = connected.filter((entry) => environmentsByMachine.has(entry.id));
        if (runnable.length === 0) continue;

        const offered = new Set(
          runnable.flatMap((entry) => environmentsByMachine.get(entry.id) ?? []),
        );
        detail = {
          usedFallback: tier === fallback,
          inputs: new Map(
            tier.map((provider) => [provider.id, provider.inputs === null ? null : {}] as const),
          ),
          machines: runnable.map((entry) =>
            candidate(
              entry,
              statsByHost.get(entry.id) ?? null,
              project.sources.find((source) => source.hostId === entry.id)?.path ?? null,
              environmentsByMachine.get(entry.id) ?? [],
            ),
          ),
          environments: tier
            .filter((provider) => offered.has(provider.id))
            .map((provider) => ({
              id: provider.id,
              name: provider.displayName,
              description: provider.description ?? "",
            })),
        };
        break;
      }
      targetDetails.set(project.id, detail);
      return detail;
    }

    let requests = 0;
    const routed = await route({
      task: text,
      instructions: {
        general: config.generalInstructions,
        projects: config.projectInstructions,
        machines: config.machineInstructions,
        environments: config.environmentInstructions,
      },
      projects: reachable,
      hostNames: new Map(hosts.map((entry) => [entry.id, entry.name] as const)),
      ask: (batch) => {
        const count = Object.keys(batch.questions).length;
        return profiler.time(`jev.request${++requests} (${count} questions)`, () =>
          askChoicesVia(routes, batch),
        );
      },
      targetsFor,
    });

    const chosenTargets = targetsFor(routed.project.value);
    const usedFallbackEnvironment = chosenTargets.usedFallback;
    const inputsByEnvironment = chosenTargets.inputs;

    const decision: RouteDecision = usedFallbackEnvironment
      ? { ...routed, environment: { ...routed.environment, source: "fallback" } }
      : routed;
    // A thread may not ask for more than its machine grants, so take the most
    // permissive mode at or below both the setting and the machine's ceiling. The
    // provider is not known here, so bb's model autopilot lowers the mode further
    // if the provider it picks allows less.
    const machine = hosts.find((entry) => entry.id === decision.machine.value.id);
    const limit = Math.min(
      PERMISSION_MODES.indexOf(permissionMode),
      PERMISSION_MODES.indexOf(machine?.maxPermissionMode ?? "full"),
    );
    permissionMode = PERMISSION_MODES[limit] ?? permissionMode;

    return {
      decision,
      profiler,
      // Null for a provider that takes no inputs, which `?? {}` would turn into some.
      environmentInputs: inputsByEnvironment.has(decision.environment.value.id)
        ? (inputsByEnvironment.get(decision.environment.value.id) ?? null)
        : {},
      permissionMode,
    };
  }

  function summarize(routed: RoutedThread): DecisionSummary {
    const { decision } = routed;
    return {
      project: { ...summarizePick(decision.project), id: decision.project.value.id },
      machine: { ...summarizePick(decision.machine), id: decision.machine.value.id },
      environment: { ...summarizePick(decision.environment), id: decision.environment.value.id },
      latencyMs: routed.profiler.elapsed(),
      timings: [...routed.profiler.spans],
    };
  }

  function userFacing(error: unknown): Error {
    if (error instanceof JevError || error instanceof RouteError) return error;
    bb.log.error(`dispatch failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return new Error(messageOf(error));
  }

  /** Route `text` and start the thread there. What `bb magic-compose spawn` runs. */
  async function dispatch(text: string): Promise<{ threadId: string; decision: DecisionSummary }> {
    try {
      const routed = await decide(text);
      const summary = summarize(routed);
      const projectId = summary.project.id;
      const thread = await routed.profiler.time("threads.spawn", () => bb.sdk.threads.spawn({
        projectId,
        // No provider, model or effort: bb's model autopilot chooses them.
        permissionMode: routed.permissionMode,
        environment: {
          type: "provider",
          environmentProviderId: summary.environment.id,
          inputs: routed.environmentInputs,
          machine: { type: "existing", hostId: summary.machine.id },
        },
        input: [{ type: "text", text, mentions: [] }],
        pluginMetadata: { decision: { ...summary, timings: [] } },
      }));
      bb.log.info(
        `dispatched ${thread.id}: ${summary.project.label} · ${summary.machine.label} · ${summary.environment.label} (decided in ${summary.latencyMs}ms, ${routed.profiler.spans
            .filter((span) => !span.name.startsWith("facts.") && span.endMs - span.startMs >= 20)
            .map((span) => `${span.name} ${span.endMs - span.startMs}ms`)
            .join(", ")})`,
      );
      // Summarized again so the timings cover the spawn as well.
      return { threadId: thread.id, decision: summarize(routed) };
    } catch (error) {
      throw userFacing(error);
    }
  }

  /** What Jev is told about each connected machine. */
  async function describeMachines() {
    const { connected, candidate } = await loadMachines();
    const machines = await Promise.all(
      connected.map(async (entry) => candidate(entry, await machineStats(entry.id), null, [])),
    );
    return machines.map((machine) => ({
      id: machine.id,
      name: machine.name,
      description: describeMachine(machine),
      stats: machine.stats,
    }));
  }

  bb.rpc.register(rpcContract, {
    status: async () => {
      const routes = await jevRoutes();
      return {
        hasApiKey: routes.length > 0,
        gateways: routes.map((entry) => JEV_PROVIDERS[entry.provider].name),
        last: lastAsked,
      };
    },
    preferences_get: async () => ({ preferences: await readPreferences() }),
    preferences_set: async ({ preferences }) => ({ preferences: await writePreferences(preferences) }),
    machines: async () => ({ machines: await describeMachines() }),
    warm: async () => {
      const routes = await jevRoutes();
      if (routes.length === 0) return { warmed: false };
      const [{ connected }, projects] = await Promise.all([
        loadMachines(),
        bb.sdk.projects.list({ includePersonal: true }),
        warmRoutes(routes),
      ]);
      // Refreshed, not just read, so a dispatch in the next moments finds them fresh.
      await Promise.allSettled([
        ...connected.map((entry) => statsCache.refresh(entry.id)),
        ...projects.map((project) => environmentsCache.refresh(project.id)),
      ]);
      return { warmed: true };
    },
    scope_get: async () => {
      const [scope, projects, environments, hosts] = await Promise.all([
        readScope(),
        bb.sdk.projects.list({ includePersonal: true }),
        bb.sdk.environments.listProviders(),
        bb.sdk.hosts.list(),
      ]);
      const hostNames = new Map(hosts.map((entry) => [entry.id, entry.name] as const));
      return {
        scope,
        projects: projects.map((project) => {
          const source = project.sources.find((entry) => entry.isDefault) ?? project.sources[0];
          return project.kind === "personal"
            ? { id: project.id, name: "No project", detail: "Threads that belong to no repository" }
            : {
                id: project.id,
                name: project.name,
                detail:
                  source === undefined
                    ? ""
                    : `${source.path} on ${hostNames.get(source.hostId) ?? "an offline machine"}`,
              };
        }),
        environments: environments
          .filter((provider) => !provider.requires.projectless && isAutomatic(provider))
          .map((provider) => ({
            id: provider.id,
            name: provider.displayName,
            detail: provider.description ?? "",
          })),
      };
    },
    scope_set: async ({ scope }) => {
      await bb.storage.kv.set(SCOPE_KEY, { ...(await readScope()), ...scope });
      return { scope: await readScope() };
    },
    preview: async ({ text, projectId }) => {
      try {
        const routed = await decide(text, { projectId });
        return { decision: summarize(routed) };
      } catch (error) {
        throw userFacing(error);
      }
    },
  });

  function parseArgs(argv: readonly string[]) {
    const switches = new Set(argv.filter((arg) => arg.startsWith("--")));
    const rest = argv.filter((arg) => !arg.startsWith("--"));
    return { switches, rest };
  }

  const usage = [
    "Usage:",
    "  bb magic-compose route <prompt> [--json] [--profile]   Show where Jev would send a prompt; starts nothing",
    "  bb magic-compose spawn <prompt> [--json]   Route a prompt and start the thread; bb's model autopilot picks the model",
    "  bb magic-compose machines [--json]         Show what Jev is told about each connected machine",
    "  bb magic-compose preferences get [--json]  Show the instructions and the other preferences",
    "  bb magic-compose preferences set <key> <value>   Set one, for example machineInstructions",
  ].join("\n");
  bb.cli.register({
    name: "magic-compose",
    summary: "Route prompts to a project, machine, and environment with Jev",
    commands: [
      {
        name: "route",
        summary: "Show where Jev would send a prompt, without starting a thread",
        usage: "bb magic-compose route <prompt> [--json] [--profile]",
      },
      {
        name: "spawn",
        summary: "Route a prompt with Jev and start the thread there",
        usage: "bb magic-compose spawn <prompt> [--json]",
      },
      {
        name: "machines",
        summary: "Show what Jev is told about each connected machine",
        usage: "bb magic-compose machines [--json]",
      },
      {
        name: "preferences",
        summary: "Show or set the instructions and the other preferences",
        usage: "bb magic-compose preferences get [--json] | preferences set <key> <value>",
      },
    ],
    async run(argv) {
      const parsedArgs = parseArgs(argv);
      const { switches } = parsedArgs;
      const json = switches.has("--json");
      const profile = switches.has("--profile");
      const [command, ...rest] = parsedArgs.rest;
      const timeline = (decision: DecisionSummary) =>
        profile ? `\n\n${formatSpans(decision.timings)}` : "";
      if (command === undefined || command === "help" || command === "--help") {
        return { exitCode: 0, stdout: usage };
      }
      if (command === "preferences") {
        const [action, key, ...payload] = rest;
        if (action === "set") {
          if (key === undefined || !(key in DEFAULT_PREFERENCES)) {
            return {
              exitCode: 1,
              stderr: `Unknown preference. Known: ${Object.keys(DEFAULT_PREFERENCES).join(", ")}`,
            };
          }
          const text = payload.join(" ");
          // Text is taken as it is; a switch, a choice, or `maySet` is given as JSON.
          const current = DEFAULT_PREFERENCES[key as keyof Preferences];
          let value: unknown = text;
          if (typeof current !== "string") {
            try {
              value = JSON.parse(text);
            } catch {
              return { exitCode: 1, stderr: `${key} takes JSON, for example ${JSON.stringify(current)}` };
            }
          }
          const patch = preferencesPatchSchema.safeParse({ [key]: value });
          if (!patch.success) {
            return { exitCode: 1, stderr: `Could not set ${key}: ${patch.error.issues[0]?.message ?? "invalid value"}` };
          }
          await writePreferences(patch.data);
          return { exitCode: 0, stdout: `Set ${key}.` };
        }
        if (action !== undefined && action !== "get") return { exitCode: 1, stderr: usage };
        const preferences = await readPreferences();
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify(preferences)
            : Object.entries(preferences)
                .map(([name, value]) =>
                  typeof value === "string" && value.includes("\n")
                    ? `${name}:\n${value.replace(/^/gm, "  ")}`
                    : `${name}: ${typeof value === "string" ? value || "(empty)" : JSON.stringify(value)}`,
                )
                .join("\n"),
        };
      }
      if (command === "machines") {
        const described = await describeMachines();
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify(described)
            : described.length === 0
              ? "No machine is connected."
              : described.map((machine) => `${machine.name}\n  ${machine.description}`).join("\n"),
        };
      }
      if (command !== "route" && command !== "spawn") return { exitCode: 1, stderr: usage };
      const prompt = promptSchema.safeParse(rest.join(" "));
      if (!prompt.success) return { exitCode: 1, stderr: usage };
      try {
        if (command === "route") {
          const decision = summarize(await decide(prompt.data));
          return {
            exitCode: 0,
            stdout: json ? JSON.stringify(decision) : formatDecision(decision) + timeline(decision),
          };
        }
        const parsed = await dispatch(prompt.data);
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify(parsed)
            : `Started ${parsed.threadId}\n${formatDecision(parsed.decision)}${timeline(parsed.decision)}`,
        };
      } catch (error) {
        return { exitCode: 1, stderr: messageOf(error) };
      }
    },
  });
}
