import { constants, realpathSync } from "node:fs";
import { unreachable } from "./assert";
import { refusals } from "./coded-error";
import { permits } from "./file";
import { blobSha, mainWorkingTree, type ProcessEnv } from "./git";
import {
  type InReview,
  insertQueued,
  insertRunning,
  isTaskName,
  type Priority,
  type Queued,
  queuedTasks,
  type Running,
  removeTask,
  replaceQueued,
  reviewTask,
  type Started,
  type Store,
  setWaiting,
  startedTasks,
  startQueued,
  stopTask,
  type Task,
  type TaskName,
  taskByName,
} from "./store";
import { runCheck, type UntilState } from "./until";

export type Context = {
  readonly store: Store;
  readonly processEnv: ProcessEnv;
  readonly now: () => Date;
  readonly untilTimeoutMs: number;
};

type State = Task["state"];

type Act = "add" | "start" | "wait" | "review" | "stop" | "done";

export const USAGE = {
  add: "agent-task add <name> --repo <path> --goal <text> [--plan <file>] [--priority urgent|high|medium|low] [--after <name>]... [--waits <text>] [--until <command>]",
  start: "agent-task start <name> --repo <path> --brief <file> [--session <id>]",
  wait: "agent-task wait <name> [--after <name>]... [--waits <text>] [--until <command>]",
  review: "agent-task review <name>",
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
      return [USAGE.add, USAGE.wait, USAGE.start, USAGE.done].map((usage) => actFor(usage, name));
    case "running":
      return [USAGE.wait, USAGE.review, USAGE.stop, USAGE.done].map((usage) => actFor(usage, name));
    case "review":
      return [USAGE.wait, USAGE.stop, USAGE.done].map((usage) => actFor(usage, name));
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
  readonly plan_unreadable: { readonly plan: string };
  readonly name_taken: { readonly name: string; readonly state: State; readonly admits: readonly string[] };
  readonly wrong_state: {
    readonly name: string;
    readonly act: Act;
    readonly state: State;
    readonly admits: readonly string[];
  };
  readonly unknown_task: { readonly name: string; readonly act: Act };
  readonly blocked: { readonly name: string; readonly after: readonly TaskName[] };
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
  plan_unreadable: {
    message: ({ plan }) => `${plan} is not a readable file`,
    resolve: () => "pass the path of the task's plan, a file you can read, or leave --plan out",
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
  blocked: {
    message: ({ name, after }) => `${name} waits after ${after.join(", ")}, which the store still holds`,
    resolve: ({ name, after }) =>
      `${after.map((other) => actFor(USAGE.done, other)).join("; ")} once each has landed, or ${actFor(USAGE.wait, name)} to wait after fewer`,
  },
});

function refuseByState(act: Act, name: string, task: Task | null) {
  if (task === null) return refuse("unknown_task", { name, act });
  const admits = admitted(name, task.state);
  if (act === "add" || act === "start") return refuse("name_taken", { name, state: task.state, admits });
  return refuse("wrong_state", { name, act, state: task.state, admits });
}

function parseName(name: string): TaskName {
  if (!isTaskName(name)) throw refuse("invalid_name", { name });
  return name;
}

function heldNames(store: Store, act: Act, names: readonly string[]): readonly TaskName[] {
  return names.map((raw) => {
    const name = parseName(raw);
    if (taskByName(store, name) === null) throw refuse("unknown_task", { name, act });
    return name;
  });
}

export type AddRequest = {
  readonly name: string;
  readonly repo: string;
  readonly goal: string;
  readonly plan: string | null;
  readonly priority: Priority | null;
  readonly after: readonly string[];
  readonly waits: string | null;
  readonly until: string | null;
};

export function add({ store, processEnv, now }: Context, request: AddRequest): Queued {
  const name = parseName(request.name);
  const repo = mainWorkingTree(request.repo, processEnv);
  if (request.plan !== null && !permits(request.plan, constants.R_OK))
    throw refuse("plan_unreadable", { plan: request.plan });
  const plan = request.plan === null ? null : realpathSync(request.plan);
  const after = heldNames(store, "add", request.after);
  const task = {
    name,
    repo,
    goal: request.goal,
    plan,
    priority: request.priority,
    waits: request.waits,
    after,
    until: request.until,
  };
  const queued = replaceQueued(store, task) ?? insertQueued(store, { ...task, added: now().toISOString() });
  if (queued === null) throw refuseByState("add", name, taskByName(store, name));
  return queued;
}

export type StartRequest = {
  readonly name: string;
  readonly repo: string;
  readonly brief: string;
  readonly session: string | null;
};

const UNQUEUED = { goal: null, plan: null, priority: null, waits: null };

export function start({ store, processEnv, now }: Context, request: StartRequest): Running {
  const name = parseName(request.name);
  const repo = mainWorkingTree(request.repo, processEnv);
  const briefSha = blobSha(request.brief, processEnv);
  if (briefSha === null) throw refuse("brief_unreadable", { brief: request.brief });
  const brief = realpathSync(request.brief);
  const started = now().toISOString();
  const task = { name, repo, brief, briefSha, session: request.session, started };
  const starting = startQueued(store, task);
  if (starting?.kind === "blocked") throw refuse("blocked", { name, after: starting.after });
  const running = starting?.task ?? insertRunning(store, { ...task, ...UNQUEUED, added: started });
  if (running === null) throw refuseByState("start", name, taskByName(store, name));
  return running;
}

export type WaitRequest = {
  readonly name: string;
  readonly after: readonly string[];
  readonly waits: string | null;
  readonly until: string | null;
};

export function wait({ store }: Context, request: WaitRequest): Task {
  const name = parseName(request.name);
  const after = heldNames(store, "wait", request.after);
  const waiting = setWaiting(store, name, { after, waits: request.waits, until: request.until });
  if (waiting === null) throw refuseByState("wait", name, taskByName(store, name));
  return waiting;
}

export function review({ store, now }: Context, raw: string): InReview {
  const name = parseName(raw);
  const reviewed = reviewTask(store, name, now().toISOString());
  if (reviewed === null) throw refuseByState("review", name, taskByName(store, name));
  return reviewed;
}

type Listed = Started & { readonly briefChanged: boolean };

type Checked = Queued & { readonly untilState: UntilState | null };

export type Listing = {
  readonly tasks: readonly Listed[];
  readonly ready: readonly Checked[];
  readonly waiting: readonly Checked[];
};

function checked(task: Queued, { processEnv, untilTimeoutMs }: Context): Checked {
  const untilState = task.until === null ? null : runCheck(task.until, task.repo, processEnv, untilTimeoutMs);
  return { ...task, untilState };
}

function isReady(task: Checked): boolean {
  if (task.after.length > 0) return false;
  if (task.untilState !== null) return task.untilState === "met";
  return task.waits === null;
}

export function list(context: Context): Listing {
  const { store, processEnv } = context;
  const tasks = startedTasks(store).map((task) => ({
    ...task,
    briefChanged: blobSha(task.brief, processEnv) !== task.briefSha,
  }));
  const queued = queuedTasks(store).map((task) => checked(task, context));
  return {
    tasks,
    ready: queued.filter(isReady),
    waiting: queued.filter((task) => !isReady(task)),
  };
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
