import { constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { unreachable } from "./assert";
import { refusals } from "./coded-error";
import { permits } from "./file";
import { blobSha, mainWorkingTree, type ProcessEnv } from "./git";
import { type Halt, readHalt, refuseWhileHalted } from "./halt";
import { parseProjectId } from "./projects";
import {
  allProjects,
  type Held,
  heldByName,
  heldProject,
  type InReview,
  insertQueued,
  insertRunning,
  isTaskName,
  type OwnerItem,
  ownerItems,
  type Priority,
  putOwnerItem,
  type ProjectId,
  type Queued,
  queuedTasks,
  type Running,
  removeTask,
  replaceQueued,
  reviewTask,
  type Started,
  type Store,
  setProject,
  setWaiting,
  startedTasks,
  startQueued,
  stopTask,
  type Task,
  type TaskName,
} from "./store";
import { runCheck, type UntilState } from "./until";
import { actFor, USAGE } from "./usage";

export type Context = {
  readonly store: Store;
  readonly haltPath: string;
  readonly processEnv: ProcessEnv;
  readonly now: () => Date;
  readonly untilTimeoutMs: number;
};

type State = Task["state"];

type Act = "add" | "start" | "wait" | "map" | "ask" | "review" | "stop" | "done";

function admitted(name: string, state: State): readonly string[] {
  switch (state) {
    case "queued":
      return [USAGE.add, USAGE.wait, USAGE.map, USAGE.start, USAGE.done].map((usage) => actFor(usage, name));
    case "running":
      return [USAGE.wait, USAGE.map, USAGE.review, USAGE.stop, USAGE.done].map((usage) =>
        actFor(usage, name),
      );
    case "review":
      return [USAGE.wait, USAGE.map, USAGE.stop, USAGE.done].map((usage) => actFor(usage, name));
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
  readonly no_brief_under: { readonly dir: string };
  readonly waits_on_owner: { readonly name: string; readonly act: Act; readonly ask: string };
  readonly no_owner_items: { readonly project: ProjectId | null };
}>({
  waits_on_owner: {
    message: ({ name, act, ask: text }) =>
      `agent-task ${act} does not apply to ${name}, which waits on the owner: ${text}`,
    resolve: ({ name }) =>
      `${actFor(USAGE.done, name)} once the owner has answered or done it; ${actFor(USAGE.ask, name)} or ${actFor(USAGE.map, name)} changes it`,
  },
  no_owner_items: {
    message: ({ project }) =>
      project === null ? "nothing waits on the owner" : `nothing in project ${project} waits on the owner`,
    resolve: () => actFor(USAGE.ask, "<name>"),
  },
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
  no_brief_under: {
    message: ({ dir }) => `no running or in-review task's brief sits under ${dir}`,
    resolve: () => "agent-task list --started",
  },
});

function refuseByState(act: Act, name: string, task: Held | null) {
  if (task === null) return refuse("unknown_task", { name, act });
  if (task.state === "owner") return refuse("waits_on_owner", { name, act, ask: task.ask });
  const admits = admitted(name, task.state);
  if (act === "add" || act === "start" || act === "ask")
    return refuse("name_taken", { name, state: task.state, admits });
  return refuse("wrong_state", { name, act, state: task.state, admits });
}

function parseName(name: string): TaskName {
  if (!isTaskName(name)) throw refuse("invalid_name", { name });
  return name;
}

function heldNames(store: Store, act: Act, names: readonly string[]): readonly TaskName[] {
  return names.map((raw) => {
    const name = parseName(raw);
    if (heldByName(store, name) === null) throw refuse("unknown_task", { name, act });
    return name;
  });
}

function projectOf(raw: string | null): ProjectId | null {
  return raw === null ? null : parseProjectId(raw);
}

function filterOf(store: Store, raw: string | null): ProjectId | null {
  return raw === null ? null : heldProject(store, parseProjectId(raw)).id;
}

export type AddRequest = {
  readonly name: string;
  readonly project: string | null;
  readonly repo: string;
  readonly goal: string;
  readonly plan: string | null;
  readonly priority: Priority | null;
  readonly after: readonly string[];
  readonly waits: string | null;
  readonly until: string | null;
};

export function add({ store, haltPath, processEnv, now }: Context, request: AddRequest): Queued {
  refuseWhileHalted(haltPath);
  const name = parseName(request.name);
  const repo = mainWorkingTree(request.repo, processEnv);
  if (request.plan !== null && !permits(request.plan, constants.R_OK))
    throw refuse("plan_unreadable", { plan: request.plan });
  const plan = request.plan === null ? null : realpathSync(request.plan);
  const after = heldNames(store, "add", request.after);
  const project = projectOf(request.project);
  const task = {
    name,
    project,
    repo,
    goal: request.goal,
    plan,
    priority: request.priority,
    waits: request.waits,
    after,
    until: request.until,
  };
  const queued = replaceQueued(store, task) ?? insertQueued(store, { ...task, added: now().toISOString() });
  if (queued === null) throw refuseByState("add", name, heldByName(store, name));
  return queued;
}

export type StartRequest = {
  readonly name: string;
  readonly project: string | null;
  readonly repo: string;
  readonly brief: string;
  readonly session: string | null;
};

const UNQUEUED = { goal: null, plan: null, priority: null, waits: null };

export function start({ store, haltPath, processEnv, now }: Context, request: StartRequest): Running {
  refuseWhileHalted(haltPath);
  const name = parseName(request.name);
  const repo = mainWorkingTree(request.repo, processEnv);
  const briefSha = blobSha(request.brief, processEnv);
  if (briefSha === null) throw refuse("brief_unreadable", { brief: request.brief });
  const brief = realpathSync(request.brief);
  const project = projectOf(request.project);
  const started = now().toISOString();
  const task = { name, project, repo, brief, briefSha, session: request.session, started };
  const starting = startQueued(store, task);
  if (starting?.kind === "blocked") throw refuse("blocked", { name, after: starting.after });
  const running = starting?.task ?? insertRunning(store, { ...task, ...UNQUEUED, added: started });
  if (running === null) throw refuseByState("start", name, heldByName(store, name));
  return running;
}

export type WaitRequest = {
  readonly name: string;
  readonly after: readonly string[];
  readonly waits: string | null;
  readonly until: string | null;
};

export function wait({ store, haltPath }: Context, request: WaitRequest): Task {
  refuseWhileHalted(haltPath);
  const name = parseName(request.name);
  const after = heldNames(store, "wait", request.after);
  const waiting = setWaiting(store, name, { after, waits: request.waits, until: request.until });
  if (waiting === null) throw refuseByState("wait", name, heldByName(store, name));
  return waiting;
}

export function map({ store, haltPath }: Context, raw: string, rawProject: string): Held {
  refuseWhileHalted(haltPath);
  const name = parseName(raw);
  const mapped = setProject(store, name, parseProjectId(rawProject));
  if (mapped === null) throw refuse("unknown_task", { name, act: "map" });
  return mapped;
}

export type AskRequest = {
  readonly name: string;
  readonly ask: string;
  readonly project: string | null;
  readonly priority: Priority | null;
};

export function ask({ store, haltPath, now }: Context, request: AskRequest): OwnerItem {
  refuseWhileHalted(haltPath);
  const name = parseName(request.name);
  const project = projectOf(request.project);
  const item = { name, project, priority: request.priority, ask: request.ask, added: now().toISOString() };
  const asked = putOwnerItem(store, item);
  if (asked === null) throw refuseByState("ask", name, heldByName(store, name));
  return asked;
}

export function review({ store, now }: Context, raw: string): InReview {
  const name = parseName(raw);
  const reviewed = reviewTask(store, name, now().toISOString());
  if (reviewed === null) throw refuseByState("review", name, heldByName(store, name));
  return reviewed;
}

export type Listed = Started & { readonly briefChanged: boolean };

export type Checked = Queued & { readonly untilState: UntilState | null };

export type StartedListing = {
  readonly tasks: readonly Listed[];
};

export type Listing = StartedListing & {
  readonly halt: Halt;
  readonly ready: readonly Checked[];
  readonly waiting: readonly Checked[];
  readonly owner: readonly OwnerItem[];
};

export type OwnerGroup = {
  readonly project: ProjectId | null;
  readonly name: string | null;
  readonly items: readonly OwnerItem[];
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

function inProject(project: ProjectId | null): (task: { readonly project: ProjectId | null }) => boolean {
  return (task) => project === null || task.project === project;
}

function startedIn({ store, processEnv }: Context, project: ProjectId | null): StartedListing {
  const tasks = startedTasks(store)
    .filter(inProject(project))
    .map((task) => ({
      ...task,
      briefChanged: blobSha(task.brief, processEnv) !== task.briefSha,
    }));
  return { tasks };
}

export function listStarted(context: Context, raw: string | null): StartedListing {
  return startedIn(context, filterOf(context.store, raw));
}

function isUnder(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

export function listStartedUnder(context: Context, dir: string, project: string | null): StartedListing {
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true)
    throw refuse("no_brief_under", { dir });
  const real = realpathSync(dir);
  const listing = listStarted(context, project);
  if (!listing.tasks.some((task) => isUnder(real, task.brief))) throw refuse("no_brief_under", { dir });
  return listing;
}

export function list(context: Context, raw: string | null): Listing {
  const project = filterOf(context.store, raw);
  const queued = queuedTasks(context.store)
    .filter(inProject(project))
    .map((task) => checked(task, context));
  return {
    ...startedIn(context, project),
    halt: readHalt(context.haltPath),
    ready: queued.filter(isReady),
    waiting: queued.filter((task) => !isReady(task)),
    owner: ownerItems(context.store).filter(inProject(project)),
  };
}

export function listOwner({ store }: Context, raw: string | null): readonly OwnerGroup[] {
  const project = filterOf(store, raw);
  const items = ownerItems(store).filter(inProject(project));
  if (items.length === 0) throw refuse("no_owner_items", { project });
  const mapped = allProjects(store).map(({ id, name }) => ({
    project: id,
    name,
    items: items.filter((item) => item.project === id),
  }));
  const unmapped = { project: null, name: null, items: items.filter((item) => item.project === null) };
  return [...mapped, unmapped].filter((group) => group.items.length > 0);
}

export function stop({ store }: Context, raw: string): Queued {
  const name = parseName(raw);
  const stopped = stopTask(store, name);
  if (stopped === null) throw refuseByState("stop", name, heldByName(store, name));
  return stopped;
}

export function done({ store }: Context, raw: string): Held {
  const name = parseName(raw);
  const removed = removeTask(store, name);
  if (removed === null) throw refuse("unknown_task", { name, act: "done" });
  return removed;
}
