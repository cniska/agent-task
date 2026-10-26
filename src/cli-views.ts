import { unreachable } from "./assert";
import type { Health } from "./doctor";
import type { Checked, Listed, Listing, StartedListing } from "./tasks";

export type View = "default" | "full";

function startedRow(task: Listed, view: View) {
  switch (view) {
    case "default":
      return { name: task.name, state: task.state, brief: task.brief, briefChanged: task.briefChanged };
    case "full":
      return {
        name: task.name,
        state: task.state,
        repo: task.repo,
        goal: task.goal,
        plan: task.plan,
        priority: task.priority,
        waits: task.waits,
        added: task.added,
        brief: task.brief,
        briefSha: task.briefSha,
        session: task.session,
        started: task.started,
        reviewed: task.state === "review" ? task.reviewed : null,
        briefChanged: task.briefChanged,
      };
    default:
      return unreachable(view);
  }
}

function queuedRow(task: Checked, view: View) {
  switch (view) {
    case "default":
      return { name: task.name, repo: task.repo };
    case "full":
      return {
        name: task.name,
        state: task.state,
        repo: task.repo,
        goal: task.goal,
        plan: task.plan,
        priority: task.priority,
        waits: task.waits,
        added: task.added,
        after: task.after,
        until: task.until,
        untilState: task.untilState,
      };
    default:
      return unreachable(view);
  }
}

function startedCount(tasks: readonly Listed[]) {
  return {
    running: tasks.filter(({ state }) => state === "running").length,
    review: tasks.filter(({ state }) => state === "review").length,
  };
}

export function startedListingView({ tasks }: StartedListing, view: View) {
  return { counts: startedCount(tasks), tasks: tasks.map((task) => startedRow(task, view)) };
}

export function listingView({ tasks, ready, waiting }: Listing, view: View) {
  return {
    counts: { ...startedCount(tasks), ready: ready.length, waiting: waiting.length },
    tasks: tasks.map((task) => startedRow(task, view)),
    ready: ready.map((task) => queuedRow(task, view)),
    waiting: waiting.map((task) => queuedRow(task, view)),
  };
}

function healthCount(checks: readonly Health[], state: Health["state"]): number {
  return checks.filter((check) => check.state === state).length;
}

export function doctorView(checks: readonly Health[], view: View) {
  const counts = {
    ok: healthCount(checks, "ok"),
    warn: healthCount(checks, "warn"),
    fail: healthCount(checks, "fail"),
  };
  switch (view) {
    case "default":
      return { counts, checks: checks.filter((check) => check.state !== "ok") };
    case "full":
      return { counts, checks };
    default:
      return unreachable(view);
  }
}
