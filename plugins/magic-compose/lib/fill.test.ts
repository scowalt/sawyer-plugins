import { describe, expect, it } from "vitest";
import type { DecisionSummary } from "../server";
import { changedSelection, selectionFor } from "./fill";

const pick = (label: string) => ({
  label,
  source: "jev" as const,
  probability: 0.9,
  confidence: 0.9,
  alternatives: [],
});

const decision: DecisionSummary = {
  project: { ...pick("bb"), id: "proj_bb" },
  machine: { ...pick("bee"), id: "host_bee" },
  environment: { ...pick("Worktree"), id: "git-worktree" },
  latencyMs: 300,
  timings: [],
};

const ALL = { project: true, placement: true };

describe("selectionFor", () => {
  it("asks for the decision's project, machine, and environment, and nothing about the model", () => {
    expect(selectionFor(decision, ALL)).toEqual({
      projectId: "proj_bb",
      environment: {
        type: "provider",
        environmentProviderId: "git-worktree",
        inputs: {},
        machine: { type: "existing", hostId: "host_bee" },
      },
    });
  });

  it("leaves permission mode to the user", () => {
    expect(selectionFor(decision, ALL)).not.toHaveProperty("permissionMode");
  });

  it("leaves out the pickers Magic Compose may not set", () => {
    expect(selectionFor(decision, { ...ALL, project: false })).not.toHaveProperty("projectId");
    expect(selectionFor(decision, { ...ALL, placement: false })).not.toHaveProperty("environment");
    expect(selectionFor(decision, { project: false, placement: false })).toEqual({});
  });
});

describe("changedSelection", () => {
  const first = selectionFor(decision, ALL);

  it("sets everything the first time", () => {
    expect(changedSelection(null, first)).toEqual(first);
  });

  it("sets nothing when Jev's answer is unchanged, leaving hand-made changes alone", () => {
    expect(changedSelection(first, selectionFor(decision, ALL))).toEqual({});
  });

  it("sets everything again when the project, machine, or environment moves", () => {
    for (const moved of [
      { ...decision, project: { ...pick("plugins"), id: "proj_plugins" } },
      { ...decision, machine: { ...pick("mac"), id: "host_mac" } },
      { ...decision, environment: { ...pick("Checkout"), id: "project-checkout" } },
    ]) {
      const next = selectionFor(moved, ALL);
      expect(changedSelection(first, next)).toEqual(next);
    }
  });

  it("still follows the project when Magic Compose may not set the machine and environment", () => {
    const projectOnly = { project: true, placement: false };
    const before = selectionFor(decision, projectOnly);
    const after = selectionFor({ ...decision, project: { ...pick("plugins"), id: "proj_plugins" } }, projectOnly);
    expect(changedSelection(before, after)).toEqual({ projectId: "proj_plugins" });
  });
});
