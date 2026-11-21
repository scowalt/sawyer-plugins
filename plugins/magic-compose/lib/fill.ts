// What the composer is asked to select for a routing decision: project, machine
// and environment. The model and effort are left to bb's model autopilot. The
// composer has the last word, and its pickers show what it settled on.
import type { ExperimentalComposerSelection } from "@get-bb/plugin-sdk/app";
import type { DecisionSummary } from "../server";
import type { MaySet } from "./preferences";

/**
 * The composer selection that carries out `decision`, leaving out the pickers
 * Magic Compose has been told not to set. Permission mode is always left to the user.
 */
export function selectionFor(
  decision: DecisionSummary,
  sets: MaySet,
): ExperimentalComposerSelection {
  return {
    ...(sets.project ? { projectId: decision.project.id } : {}),
    ...(sets.placement
      ? {
          environment: {
            type: "provider" as const,
            environmentProviderId: decision.environment.id,
            // Not applied: the composer keeps its own inputs, such as the branch to start from.
            inputs: {},
            machine: { type: "existing" as const, hostId: decision.machine.id },
          },
        }
      : {}),
  };
}

/** What identifies the project and where a selection puts the thread. */
function placement(selection: ExperimentalComposerSelection): string {
  const environment = selection.environment;
  const where =
    environment?.type === "provider"
      ? `${environment.environmentProviderId} on ${environment.machine?.type === "existing" ? environment.machine.hostId : ""}`
      : JSON.stringify(environment ?? null);
  return `${selection.projectId ?? ""} ${where}`;
}

/**
 * What to set now that Jev's answer has gone from `previous` to `next`: only
 * what changed, so a picker changed by hand stays as it was left until Jev's
 * answer for it changes. Empty when there is nothing to set.
 */
export function changedSelection(
  previous: ExperimentalComposerSelection | null,
  next: ExperimentalComposerSelection,
): ExperimentalComposerSelection {
  // A move sets everything again: BB remembers the environment per project.
  return previous === null || placement(previous) !== placement(next) ? next : {};
}
