import { describe, expect, it } from "vitest";
import {
  backtestRows,
  isNoise,
  mappedModel,
  markShareDraws,
  normalizePrompt,
  parseMapping,
  score,
  shareTally,
  tally,
  type HistoryRow,
  type ShareDraw,
} from "./history";

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    threadId: "thr_1",
    createdAt: 0,
    project: "bb",
    providerId: "codex",
    model: "astra",
    effort: "medium",
    prompt: "Fix the sidebar flicker when a plugin reloads",
    share: null,
    ...overrides,
  };
}

describe("isNoise", () => {
  it("drops greetings and connection tests, keeps real short asks", () => {
    for (const prompt of [
      "hello",
      "u up",
      "how are you today",
      "Reply with the single word ok.",
      "Quick compose plugin test. Reply with just the word OK.",
    ]) {
      expect(isNoise(prompt)).toBe(true);
    }
    expect(isNoise("/approve-contributor banjerluke")).toBe(false);
    expect(isNoise("what gpu is in this computer")).toBe(false);
  });
});

describe("model mappings", () => {
  it("counts threads on a matching model as the mapped one", () => {
    const mappings = [parseMapping("-preview=big-model")];
    expect(mappedModel("big-model-preview[1m]", mappings)).toBe("big-model");
    expect(mappedModel("small-model", mappings)).toBe("small-model");
    expect(() => parseMapping("no-equals")).toThrow("Expected <regex>=<model id>");
  });
});

describe("tally", () => {
  it("counts efforts per model, most used model first", () => {
    expect(tally([row(), row({ effort: "low" }), row({ model: "fable", effort: "high" })])).toEqual([
      { model: "astra", total: 2, efforts: { medium: 1, low: 1 } },
      { model: "fable", total: 1, efforts: { high: 1 } },
    ]);
  });
});

describe("backtestRows", () => {
  it("keeps one row per distinct ask and says what it dropped", () => {
    const { rows, skipped } = backtestRows(
      [
        row(),
        row({ threadId: "thr_2" }), // same ask, same choice
        row({ prompt: "hello" }),
        row({ prompt: "Configure the secret preview model" }),
        row({ model: "some-other-model" }),
        row({ model: "fable-preview", effort: "xhigh", prompt: "Build a new plugin from scratch" }),
      ],
      {
        mappings: [parseMapping("-preview=fable")],
        exclude: /secret/iu,
        rotation: new Set(["astra", "fable"]),
      },
    );
    expect(rows.map((entry) => [entry.model, entry.effort])).toEqual([
      ["astra", "medium"],
      ["fable", "xhigh"],
    ]);
    expect(skipped).toEqual({ noise: 1, excluded: 1, notInRotation: 1, duplicate: 1, shareDraw: 0 });
  });
});

const MINUTE = 60_000;
const neon = { providerId: "acp-antigravity-acp", model: "gemini-4-neon" };
const drawn: ShareDraw = {
  key: "0.1234",
  at: 1_000_000,
  prompt: "Fix the sidebar flicker",
  target: neon,
  replaced: { providerId: "pi", model: "claude-opus-5-5", effort: "xhigh" },
};
const neonRow = (overrides: Partial<HistoryRow> = {}) =>
  row({ ...neon, effort: "high", createdAt: drawn.at + 5_000, ...overrides });

describe("markShareDraws", () => {
  it("marks a thread that began with a drawn prompt on the target soon after", () => {
    const [marked] = markShareDraws([neonRow()], [drawn]);
    expect(marked?.share).toEqual({ replaced: drawn.replaced });
  });

  it("leaves alone a thread on another model, another prompt, or outside the time window", () => {
    const rows = [
      neonRow({ providerId: "pi", model: "claude-opus-5-5" }),
      neonRow({ prompt: "Add a dark mode toggle" }),
      neonRow({ createdAt: drawn.at - 2 * MINUTE }),
      neonRow({ createdAt: drawn.at + 7 * 60 * MINUTE }),
    ];
    expect(markShareDraws(rows, [drawn]).map((entry) => entry.share)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("takes the latest of several matching draws", () => {
    const later: ShareDraw = {
      ...drawn,
      key: "0.9",
      at: drawn.at + MINUTE,
      replaced: { providerId: "pi", model: "claude-sonnet-5-5", effort: "medium" },
    };
    const [marked] = markShareDraws([neonRow({ createdAt: later.at + 1_000 })], [drawn, later]);
    expect(marked?.share?.replaced.model).toBe("claude-sonnet-5-5");
  });
});

describe("normalizePrompt", () => {
  it("collapses whitespace like a history row's prompt", () => {
    expect(normalizePrompt("  fix\n the   bug ")).toBe("fix the bug");
  });
});

describe("share draws apart from the user's choices", () => {
  const share = { replaced: drawn.replaced };
  const rows = [row(), neonRow({ share }), neonRow({ share, effort: "high" })];

  it("tally counts only what the user chose", () => {
    expect(tally(rows)).toEqual([{ model: "astra", total: 1, efforts: { medium: 1 } }]);
  });

  it("shareTally reports the draws and what they replaced", () => {
    expect(shareTally(rows)).toEqual({
      total: 2,
      models: ["gemini-4-neon"],
      replaced: { "claude-opus-5-5 xhigh": 2 },
    });
  });

  it("backtestRows counts a draw as left out and never scores it", () => {
    const { rows: kept, skipped } = backtestRows(rows, {
      mappings: [],
      exclude: null,
      rotation: new Set(["astra", "gemini-4-neon"]),
    });
    expect(kept.map((entry) => entry.model)).toEqual(["astra"]);
    expect(skipped.shareDraw).toBe(2);
    expect(skipped.notInRotation).toBe(0);
  });
});

describe("score", () => {
  it("reports agreement beside the always-pick-the-favourite baseline, scoring only allowed efforts", () => {
    const results = [
      { row: row(), model: "astra", effort: "low" },
      { row: row({ effort: "high" }), model: "astra", effort: "high" },
      { row: row({ model: "fable", effort: "ultracode" }), model: "astra", effort: "xhigh" },
      { row: row({ model: "fable", effort: "xhigh" }), model: "fable", effort: "medium" },
    ];
    const scored = score(results, new Set(["low", "medium", "high", "xhigh"]));
    expect(scored.model).toMatchObject({ agreementPercent: 75, alwaysMostCommonPercent: 50 });
    expect(scored.model.confusion).toEqual({
      "astra -> astra": 2,
      "fable -> astra": 1,
      "fable -> fable": 1,
    });
    // The ultracode thread is left out: the rules are not allowed to pick it.
    expect(scored.effort).toMatchObject({
      scored: 3,
      agreementPercent: 33,
      withinOneLevelPercent: 67,
    });
  });
});
