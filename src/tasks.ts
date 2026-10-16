import { realpathSync } from "node:fs";
import { unreachable } from "./assert";
import { refusals } from "./coded-error";
import { blobSha, mainWorkingTree, type ProcessEnv } from "./git";
import {
  insertRunning,
  isTaskName,
  type Queued,
  queuedTasks,
  type Running,
  removeTask,
  type Store,
  startedTasks,
  startQueued,
  stopTask,
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

type Act = "start" | "stop" | "done";

export const USAGE = {
  start: "agent-task start <name> --repo <path> --brief <file> [--session <id>]",
  list: "agent-task list",
  stop: "agent-task stop <name>",
  done: "agent-task done <name>",
} as const;

export function actFor(usage: string, name: string): string {
  return usage.replace("<name>", name);
}

function admitted(name: string, state: State): readonly string[] {
  switch (state) {
    case "queued":
      return [USAGE.start, USAGE.done].map((usage) => actFor(usage, name));
    case "running":
      return [USAGE.stop, USAGE.done].map((usage) => actFor(usage, name));
    default:
      return unreachable(state);
  }
}

function admittedText(name: string, state: State, admits: readonly string[]): string {
  return `${name} is ${state}, which admits: ${admits.join("; ")}`;
}

const refuse = refusals<{
  readonly invalid_name: { readonly name: string };
  readonly brief_unreadable: { readonly brief: string };
  readonly name_taken: { readonly name: string; readonly state: State; readonly admits: readonly string[] };
  readonly wrong_state: {
    readonly name: string;
    readonly act: Act;
    readonly state: State;
    readonly admits: readonly string[];
  };
  readonly unknown_task: { readonly name: string; readonly act: Act };
}>({
  invalid_name: {
    message: ({ name }) =>
      `${JSON.stringify(name)} is not a task name: lowercase letters and digits in dash-separated words`,
    resolve: () => "pass a kebab-case name such as task-first-version",
  },
  brief_unreadable: {
    message: ({ brief }) => `${brief} is not a readable file`,
    resolve: () => "pass the path of the task's brief, a file you can read",
  },
  name_taken: {
    message: ({ name, state }) => `the store already holds a task named ${name}, ${state}`,
    resolve: ({ name, state, admits }) => admittedText(name, state, admits),
  },
  wrong_state: {
    message: ({ name, act, state }) => `agent-task ${act} does not apply to ${name}, which is ${state}`,
    resolve: ({ name, state, admits }) => admittedText(name, state, admits),
  },
  unknown_task: {
    message: ({ name }) => `the store holds no task named ${name}`,
    resolve: ({ name }) => actFor(USAGE.start, name),
  },
});

function refuseByState(act: Act, name: string, task: Task | null) {
  if (task === null) return refuse("unknown_task", { name, act });
  const admits = admitted(name, task.state);
  if (act === "start") return refuse("name_taken", { name, state: task.state, admits });
  return refuse("wrong_state", { name, act, state: task.state, admits });
}

function parseName(name: string): TaskName {
  if (!isTaskName(name)) throw refuse("invalid_name", { name });
  return name;
}

export type StartRequest = {
  readonly name: string;
  readonly repo: string;
  readonly brief: string;
  readonly session: string | null;
};

export function start({ store, processEnv, now }: Context, request: StartRequest): Running {
  const name = parseName(request.name);
  const repo = mainWorkingTree(request.repo, processEnv);
  const briefSha = blobSha(request.brief, processEnv);
  if (briefSha === null) throw refuse("brief_unreadable", { brief: request.brief });
  const brief = realpathSync(request.brief);
  const started = now().toISOString();
  const task = { name, repo, brief, briefSha, session: request.session, started };
  const running = startQueued(store, task) ?? insertRunning(store, { ...task, added: started });
  if (running === null) throw refuseByState("start", name, taskByName(store, name));
  return running;
}

type Listed = Running & { readonly briefChanged: boolean };

export type Listing = { readonly tasks: readonly Listed[]; readonly ready: readonly Queued[] };

export function list({ store, processEnv }: Context): Listing {
  const tasks = startedTasks(store).map((task) => ({
    ...task,
    briefChanged: blobSha(task.brief, processEnv) !== task.briefSha,
  }));
  return { tasks, ready: queuedTasks(store) };
}

export function stop({ store }: Context, raw: string): Queued {
  const name = parseName(raw);
  const stopped = stopTask(store, name);
  if (stopped === null) throw refuseByState("stop", name, taskByName(store, name));
  return stopped;
}

export function done({ store }: Context, raw: string): Task {
  const name = parseName(raw);
  const removed = removeTask(store, name);
  if (removed === null) throw refuse("unknown_task", { name, act: "done" });
  return removed;
}
