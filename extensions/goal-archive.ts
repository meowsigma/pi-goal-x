import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nowIso } from "./goal-record.ts";
import type { GoalCore } from "./goal-state.ts";

/** Archive an already-complete goal when completion happened after turn_end. */
export function archiveCompletedGoal(core: GoalCore, ctx: ExtensionContext): boolean {
  const completedGoal = core.state.goal;
  if (!completedGoal || completedGoal.status !== "complete" || completedGoal.archivedPath) return false;
  let result;
  try {
    result = core.goalService.apply(ctx, {
      reconcile: false,
      archive: true,
      commitFocused: false,
      mutate: () => completedGoal,
      ledger: (written) => [{ type: "goal_completed", goalId: completedGoal.id, archivePath: written.archivedPath, at: nowIso() }],
    });
  } catch {
    return false;
  }
  if (!result.ok) return false;
  core.goalsById.delete(completedGoal.id);
  core.assignFocusedGoalId(null);
  core.appendFocusEntry(null, "completed");
  try {
    core.goalService.appendEvents(ctx, [{ type: "goal_archived", goalId: completedGoal.id, archivePath: result.goal?.archivedPath ?? "", at: nowIso() }]);
  } catch {}
  return true;
}
