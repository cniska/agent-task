import { constants, statSync } from "node:fs";
import { join } from "node:path";
import { unreachable } from "./assert";
import { CodedError } from "./coded-error";
import { permits } from "./file";
import { mainWorkingTree, type ProcessEnv } from "./git";
import {
  closeStore,
  queuedTasks,
  type Read,
  readStore,
  SCHEMA_VERSION,
  type Started,
  type Store,
  startedTasks,
  type Task,
} from "./store";
import { actFor, USAGE } from "./tasks";

export const DOCTOR_USAGE = "agent-task doctor";

const RERUN = `then run ${DOCTOR_USAGE} again`;

const HOOKS = "the plugin's PreToolUse hook (before-edit.sh) and its SessionStart hook (session-start.sh)";

const HOOK_PROGRAMS = [
  { program: "bash", silence: `${HOOKS} cannot start, so they deny nothing and print nothing` },
  { program: "agent-task", silence: `${HOOKS} deny nothing and print nothing` },
  { program: "jq", silence: `${HOOKS} deny nothing and print only a note on stderr` },
  { program: "realpath", silence: `${HOOKS} deny nothing and print only a note on stderr` },
] as const;

const STORE_REFUSALS = ["store_version", "store_unopenable", "store_busy"];

type State = "ok" | "warn" | "fail";

type Health = {
  readonly name: string;
  readonly state: State;
  readonly detail: string;
  readonly fix: string | null;
};

type DoctorReport = { readonly checks: readonly Health[]; readonly failing: number };

export type DoctorRequest = {
  readonly storePath: string;
  readonly busyWaitMs: number;
  readonly processEnv: ProcessEnv;
  readonly searchPath: readonly string[];
};

function refused<T>(probe: () => T, codes: readonly string[]): T | CodedError {
  try {
    return probe();
  } catch (error) {
    if (error instanceof CodedError && codes.includes(error.code)) return error;
    throw error;
  }
}

function lookUp(program: string, searchPath: readonly string[]): string | null {
  return searchPath.map((dir) => join(dir, program)).find((file) => permits(file, constants.X_OK)) ?? null;
}

function searched(searchPath: readonly string[]): string {
  return searchPath.length === 0 ? "PATH names no directory" : `not found in ${searchPath.join(", ")}`;
}

function hookProgramHealth(program: string, silence: string, searchPath: readonly string[]): Health {
  const file = lookUp(program, searchPath);
  if (file !== null) return { name: program, state: "ok", detail: `found at ${file}`, fix: null };
  return {
    name: program,
    state: "warn",
    detail: `${searched(searchPath)}; without it ${silence}`,
    fix: `install ${program} on the PATH Claude Code starts with, then run ${DOCTOR_USAGE} under that PATH`,
  };
}

function gitHealth(file: string | null, searchPath: readonly string[]): Health {
  if (file !== null) return { name: "git", state: "ok", detail: `found at ${file}`, fix: null };
  return {
    name: "git",
    state: "fail",
    detail: `${searched(searchPath)}; every agent-task command runs git`,
    fix: `install git and put it on PATH, ${RERUN}`,
  };
}

function storeHealth(path: string, read: Read | CodedError): Health {
  if (read instanceof CodedError)
    return { name: "store", state: "fail", detail: read.message, fix: read.resolve };
  switch (read.kind) {
    case "none":
      return {
        name: "store",
        state: "ok",
        detail: `no store at ${path} yet; add or start creates it`,
        fix: null,
      };
    case "migratable":
      return {
        name: "store",
        state: "warn",
        detail: `${path} is a version ${read.found} store; this agent-task reads version ${SCHEMA_VERSION}`,
        fix: `run ${USAGE.list}, which migrates it, ${RERUN}`,
      };
    case "open":
      return { name: "store", state: "ok", detail: `${path} is a store this agent-task reads`, fix: null };
    default:
      return unreachable(read);
  }
}

function repositoryHealth(task: Task, processEnv: ProcessEnv, gitFound: boolean): Health {
  const name = `${task.name} repository`;
  const restore = `put the repository back at ${task.repo}, or ${actFor(USAGE.done, task.name)}`;
  if (statSync(task.repo, { throwIfNoEntry: false })?.isDirectory() !== true)
    return { name, state: "fail", detail: `${task.repo} is gone`, fix: restore };
  if (!gitFound)
    return { name, state: "warn", detail: "unchecked: git is not on PATH", fix: `put git on PATH, ${RERUN}` };
  const tree = refused(() => mainWorkingTree(task.repo, processEnv), ["not_a_checkout"]);
  if (tree instanceof CodedError) return { name, state: "warn", detail: tree.message, fix: restore };
  if (tree !== task.repo)
    return {
      name,
      state: "warn",
      detail: `${task.repo} is no longer its own main working tree: git finds ${tree}`,
      fix: restore,
    };
  return { name, state: "ok", detail: `${task.repo} is its own main working tree`, fix: null };
}

function briefHealth(task: Started): Health {
  const name = `${task.name} brief`;
  if (permits(task.brief, constants.R_OK))
    return { name, state: "ok", detail: `${task.brief} is readable`, fix: null };
  return {
    name,
    state: "warn",
    detail: `${task.brief} is not a readable file`,
    fix: `put the brief back at ${task.brief}, or ${actFor(USAGE.stop, task.name)}`,
  };
}

function planHealth(task: Task): readonly Health[] {
  if (task.plan === null) return [];
  const name = `${task.name} plan`;
  if (permits(task.plan, constants.R_OK))
    return [{ name, state: "ok", detail: `${task.plan} is readable`, fix: null }];
  return [
    {
      name,
      state: "warn",
      detail: `${task.plan} is not a readable file`,
      fix: `put the plan back at ${task.plan}, or ${actFor(USAGE.add, task.name)} again with another --plan or none`,
    },
  ];
}

function taskHealth(store: Store, processEnv: ProcessEnv, gitFound: boolean): readonly Health[] {
  try {
    const started = startedTasks(store);
    const tasks = [...started, ...queuedTasks(store)];
    const repositories = tasks.map((task) => repositoryHealth(task, processEnv, gitFound));
    return [...repositories, ...started.map(briefHealth), ...tasks.flatMap(planHealth)];
  } finally {
    closeStore(store);
  }
}

export function doctor({ storePath, busyWaitMs, processEnv, searchPath }: DoctorRequest): DoctorReport {
  const git = lookUp("git", searchPath);
  const read = refused(() => readStore(storePath, busyWaitMs), STORE_REFUSALS);
  const checks = [
    storeHealth(storePath, read),
    ...HOOK_PROGRAMS.map(({ program, silence }) => hookProgramHealth(program, silence, searchPath)),
    gitHealth(git, searchPath),
    ...(read instanceof CodedError || read.kind !== "open"
      ? []
      : taskHealth(read.store, processEnv, git !== null)),
  ];
  return { checks, failing: checks.filter(({ state }) => state === "fail").length };
}
