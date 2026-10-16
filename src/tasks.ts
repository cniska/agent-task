import { realpathSync, statSync } from "node:fs";
import { invariant, unreachable } from "./assert";
import { refusals } from "./coded-error";
import {
  blobSha,
  commitOf,
  isAncestor,
  isSha,
  landingBranch,
  mainWorkingTree,
  type ProcessEnv,
  type Sha,
} from "./git";
import {
  type Commits,
  type Done,
  type Dropped,
  dropTask,
  finishTask,
  insertTask,
  isTaskName,
  type Running,
  runningTasks,
  type Store,
  type Task,
  type TaskName,
  taskByName,
} from "./store";

export type Context = {
  readonly store: Store;
  readonly processEnv: ProcessEnv;
  readonly now: () => Date;
};

type State = Task["state"];

type Act = "start" | "done" | "drop";

export const USAGE = {
  start: "agent-task start <name> --repo <path> --brief <file>",
  list: "agent-task list",
  done: "agent-task done <name> --commit <sha>...",
  drop: "agent-task drop <name> --reason <text>",
} as const;

function actFor(usage: string, name: string): string {
  return usage.replace("<name>", name);
}

function admitted(name: string, state: State): readonly string[] {
  switch (state) {
    case "running":
      return [USAGE.done, USAGE.drop].map((usage) => actFor(usage, name));
    case "done":
    case "dropped":
      return [];
    default:
      return unreachable(state);
  }
}

function admittedText(name: string, state: State, admits: readonly string[]): string {
  if (admits.length === 0) return `${name} is ${state}, which is final; start new work under another name`;
  return `${name} is ${state}, which admits: ${admits.join("; ")}`;
}

const refuse = refusals<{
  readonly invalid_name: { readonly name: string };
  readonly invalid_sha: { readonly name: string; readonly values: readonly string[] };
  readonly brief_unreadable: { readonly brief: string };
  readonly name_taken: { readonly name: string; readonly state: State; readonly admits: readonly string[] };
  readonly not_running: {
    readonly name: string;
    readonly act: Act;
    readonly state: State;
    readonly admits: readonly string[];
  };
  readonly unknown_task: { readonly name: string; readonly act: Act };
  readonly repo_missing: { readonly name: string; readonly repo: string };
  readonly not_landed: {
    readonly name: string;
    readonly branch: string;
    readonly unknown: readonly string[];
    readonly unmerged: readonly string[];
  };
}>({
  invalid_name: {
    message: ({ name }) =>
      `${JSON.stringify(name)} is not a task name: lowercase letters and digits in dash-separated words`,
    resolve: () => "pass a kebab-case name such as task-first-version",
  },
  invalid_sha: {
    message: ({ values }) => `not a commit sha: ${values.map((value) => JSON.stringify(value)).join(", ")}`,
    resolve: ({ name }) =>
      `name each commit by its sha, in full or at least its first 4 hex digits: agent-task done ${name} --commit <sha>...`,
  },
  brief_unreadable: {
    message: ({ brief }) => `${brief} is not a readable file`,
    resolve: () => "pass the path of the task's brief, a file you can read",
  },
  name_taken: {
    message: ({ name, state }) => `the store already holds a task named ${name}, ${state}`,
    resolve: ({ name, state, admits }) => admittedText(name, state, admits),
  },
  not_running: {
    message: ({ name, act, state }) => `agent-task ${act} needs a running task, and ${name} is ${state}`,
    resolve: ({ name, state, admits }) => admittedText(name, state, admits),
  },
  unknown_task: {
    message: ({ name }) => `the store holds no task named ${name}`,
    resolve: ({ name }) => actFor(USAGE.start, name),
  },
  repo_missing: {
    message: ({ name, repo }) => `${name}'s repository ${repo} is gone`,
    resolve: ({ name, repo }) =>
      `put the repository back at ${repo} and run done again, or ${actFor(USAGE.drop, name)}`,
  },
  not_landed: {
    message: ({ branch, unknown, unmerged }) =>
      [
        ...(unknown.length > 0
          ? [`not a commit in the repository after fetching: ${unknown.join(", ")}`]
          : []),
        ...(unmerged.length > 0 ? [`not reachable from ${branch}: ${unmerged.join(", ")}`] : []),
      ].join("; "),
    resolve: ({ branch }) =>
      `land each commit on ${branch} so it is reachable from there (a squash or rebase merge makes new commits: pass those), then run done again`,
  },
});

function refuseByState(act: Act, name: string, task: Task | null) {
  if (task === null) return refuse("unknown_task", { name, act });
  const admits = admitted(name, task.state);
  if (act === "start") return refuse("name_taken", { name, state: task.state, admits });
  return refuse("not_running", { name, act, state: task.state, admits });
}

function parseName(name: string): TaskName {
  if (!isTaskName(name)) throw refuse("invalid_name", { name });
  return name;
}

function parseShas(name: TaskName, values: readonly [string, ...string[]]): readonly Sha[] {
  const shas: Sha[] = [];
  const invalid: string[] = [];
  for (const value of values) {
    const sha = value.toLowerCase();
    if (isSha(sha)) shas.push(sha);
    else invalid.push(value);
  }
  if (invalid.length > 0) throw refuse("invalid_sha", { name, values: invalid });
  return shas;
}

function requireRepository(task: Running): void {
  if (statSync(task.repo, { throwIfNoEntry: false })?.isDirectory() !== true)
    throw refuse("repo_missing", { name: task.name, repo: task.repo });
}

export type StartRequest = { readonly name: string; readonly repo: string; readonly brief: string };

export function start({ store, processEnv, now }: Context, request: StartRequest): Running {
  const name = parseName(request.name);
  const repo = mainWorkingTree(request.repo, processEnv);
  const briefSha = blobSha(request.brief, processEnv);
  if (briefSha === null) throw refuse("brief_unreadable", { brief: request.brief });
  const brief = realpathSync(request.brief);
  const task = { name, repo, brief, briefSha, started: now().toISOString() };
  const started = insertTask(store, task);
  if (started === null) throw refuseByState("start", name, taskByName(store, name));
  return started;
}

export type Listed = Running & { readonly briefChanged: boolean };

export function list({ store, processEnv }: Context): readonly Listed[] {
  return runningTasks(store).map((task) => ({
    ...task,
    briefChanged: blobSha(task.brief, processEnv) !== task.briefSha,
  }));
}

export function drop({ store, now }: Context, raw: string, reason: string): Dropped {
  const name = parseName(raw);
  const dropped = dropTask(store, name, now().toISOString(), reason);
  if (dropped === null) throw refuseByState("drop", name, taskByName(store, name));
  return dropped;
}

export function done(
  { store, processEnv, now }: Context,
  raw: string,
  values: readonly [string, ...string[]],
): Done {
  const name = parseName(raw);
  const shas = parseShas(name, values);
  const task = taskByName(store, name);
  if (task === null || task.state !== "running") throw refuseByState("done", name, task);
  requireRepository(task);
  const { ref, branch } = landingBranch(task.repo, processEnv);
  const unknown: string[] = [];
  const unmerged: string[] = [];
  const landed: string[] = [];
  for (const sha of shas) {
    const commit = commitOf(task.repo, sha, processEnv);
    if (commit === null) unknown.push(sha);
    else if (!isAncestor(task.repo, commit, ref, processEnv)) unmerged.push(sha);
    else if (!landed.includes(commit)) landed.push(commit);
  }
  if (unknown.length > 0 || unmerged.length > 0)
    throw refuse("not_landed", { name, branch, unknown, unmerged });
  const [first, ...rest] = landed;
  invariant(first !== undefined, "a non-empty sha list with none refused lands one");
  const commits: Commits = [first, ...rest];
  const finished = finishTask(store, name, now().toISOString(), commits);
  if (finished === null) throw refuseByState("done", name, taskByName(store, name));
  return finished;
}
