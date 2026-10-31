import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { unreachable } from "./assert";
import { type Command, type Outcome, type Runtime, usageError } from "./cli-contract";
import { doctorView, listingView, projectsView, startedListingView, type View } from "./cli-views";
import { messageOf } from "./coded-error";
import { DOCTOR_USAGE, doctor } from "./doctor";
import { HALT_USAGE, haltedNow, liftHalt, raiseHalt } from "./halt";
import { haltPath, storePath } from "./paths";
import { addProject, dropProject, listProjects } from "./projects";
import { closeStore, isPriority, openStore, type Priority } from "./store";
import {
  add,
  type Context,
  done,
  list,
  listStarted,
  listStartedUnder,
  map,
  review,
  start,
  stop,
  wait,
} from "./tasks";
import { PROJECT_USAGE, USAGE } from "./usage";

type Flags = Readonly<Record<string, { readonly type: "string" | "boolean"; readonly multiple?: boolean }>>;

type Parsed = {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, string | boolean | readonly (string | boolean)[] | undefined>>;
};

function parsed(command: Command, args: readonly string[], options: Flags): Parsed {
  try {
    const { positionals, values } = parseArgs({
      args: [...args],
      options,
      allowPositionals: true,
      strict: true,
    });
    return { positionals, values };
  } catch (error) {
    throw usageError("bad_arguments", {
      command: command.name,
      detail: messageOf(error),
      usage: command.usage,
    });
  }
}

function refuseArguments(command: Command, detail: string): never {
  throw usageError("bad_arguments", { command: command.name, detail, usage: command.usage });
}

function noArguments(command: Command, positionals: readonly string[]): void {
  if (positionals.length > 0)
    refuseArguments(command, `takes no argument, and got: ${positionals.join(" ")}`);
}

function oneName(command: Command, positionals: readonly string[]): string {
  const [name, ...rest] = positionals;
  if (name === undefined || rest.length > 0)
    refuseArguments(command, `takes one task name, and got: ${positionals.join(" ") || "none"}`);
  return name;
}

function oneReason(command: Command, positionals: readonly string[]): string {
  const [reason, ...rest] = positionals;
  if (!isText(reason) || rest.length > 0)
    refuseArguments(command, `takes one reason, quoted, and got: ${positionals.join(" ") || "none"}`);
  return reason;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function oneValue(command: Command, values: Parsed["values"], flag: string): string {
  const value = values[flag];
  if (!isText(value)) refuseArguments(command, `needs --${flag} with a value`);
  return value;
}

function optionalValue(command: Command, values: Parsed["values"], flag: string): string | null {
  const value = values[flag];
  if (value === undefined) return null;
  if (!isText(value)) refuseArguments(command, `needs a value after --${flag}`);
  return value;
}

function manyValues(command: Command, values: Parsed["values"], flag: string): readonly string[] {
  const value = values[flag];
  if (value === undefined) return [];
  const given = typeof value === "string" ? [value] : value;
  if (typeof given === "boolean" || !given.every(isText))
    refuseArguments(command, `needs a value after --${flag}`);
  return given;
}

function afterNames(command: Command, values: Parsed["values"], name: string): readonly string[] {
  const after = manyValues(command, values, "after");
  if (after.includes(name)) refuseArguments(command, `${name} cannot wait after itself`);
  return after;
}

function priorityValue(command: Command, values: Parsed["values"]): Priority | null {
  const value = optionalValue(command, values, "priority");
  if (value === null) return null;
  if (!isPriority(value)) refuseArguments(command, `--priority is urgent, high, medium or low, not ${value}`);
  return value;
}

function viewOf(values: Parsed["values"]): View {
  return values.full === true ? "full" : "default";
}

function withContext(runtime: Runtime, act: (context: Context) => unknown): Outcome {
  const store = openStore(storePath(runtime.env), runtime.busyWaitMs);
  try {
    return {
      value: act({
        store,
        haltPath: haltPath(runtime.env),
        processEnv: runtime.processEnv,
        now: runtime.now,
        untilTimeoutMs: runtime.untilTimeoutMs,
      }),
      status: 0,
    };
  } finally {
    closeStore(store);
  }
}

const addCommand: Command = {
  name: "add",
  usage: USAGE.add,
  summary:
    "queue a task: its repository, goal, project, plan, priority, what it waits for and the check that says its wait is met; on a queued name, replace them",
  run(args, runtime) {
    const { positionals, values } = parsed(this, args, {
      repo: { type: "string" },
      goal: { type: "string" },
      project: { type: "string" },
      plan: { type: "string" },
      priority: { type: "string" },
      after: { type: "string", multiple: true },
      waits: { type: "string" },
      until: { type: "string" },
    });
    const name = oneName(this, positionals);
    const repo = resolve(runtime.cwd, oneValue(this, values, "repo"));
    const goal = oneValue(this, values, "goal");
    const project = optionalValue(this, values, "project");
    const planPath = optionalValue(this, values, "plan");
    const plan = planPath === null ? null : resolve(runtime.cwd, planPath);
    const priority = priorityValue(this, values);
    const after = afterNames(this, values, name);
    const waits = optionalValue(this, values, "waits");
    const until = optionalValue(this, values, "until");
    return withContext(runtime, (context) =>
      add(context, { name, project, repo, goal, plan, priority, after, waits, until }),
    );
  },
};

const startCommand: Command = {
  name: "start",
  usage: USAGE.start,
  summary:
    "run a task, new or queued: its repository, its brief, the brief's content, the session and, when given, its project",
  run(args, runtime) {
    const { positionals, values } = parsed(this, args, {
      repo: { type: "string" },
      brief: { type: "string" },
      project: { type: "string" },
      session: { type: "string" },
    });
    const name = oneName(this, positionals);
    const repo = resolve(runtime.cwd, oneValue(this, values, "repo"));
    const brief = resolve(runtime.cwd, oneValue(this, values, "brief"));
    const project = optionalValue(this, values, "project");
    const session = optionalValue(this, values, "session");
    return withContext(runtime, (context) => start(context, { name, project, repo, brief, session }));
  },
};

const waitCommand: Command = {
  name: "wait",
  usage: USAGE.wait,
  summary:
    "replace what a task waits for: tasks to land and a check that says the wait is met, on a queued task, and anything else as text",
  run(args, runtime) {
    const { positionals, values } = parsed(this, args, {
      after: { type: "string", multiple: true },
      waits: { type: "string" },
      until: { type: "string" },
    });
    const name = oneName(this, positionals);
    const after = afterNames(this, values, name);
    const waits = optionalValue(this, values, "waits");
    const until = optionalValue(this, values, "until");
    return withContext(runtime, (context) => wait(context, { name, after, waits, until }));
  },
};

const mapCommand: Command = {
  name: "map",
  usage: USAGE.map,
  summary: "map a task in any state to a project the store holds",
  run(args, runtime) {
    const { positionals, values } = parsed(this, args, { project: { type: "string" } });
    const name = oneName(this, positionals);
    const project = oneValue(this, values, "project");
    return withContext(runtime, (context) => map(context, name, project));
  },
};

const reviewCommand: Command = {
  name: "review",
  usage: USAGE.review,
  summary:
    "record that a running task was handed back for review; its brief and brief sha stay recorded until stop or done",
  run(args, runtime) {
    const name = oneName(this, parsed(this, args, {}).positionals);
    return withContext(runtime, (context) => review(context, name));
  },
};

const listCommand: Command = {
  name: "list",
  usage: USAGE.list,
  summary:
    "list the running and in-review tasks, flagging each whose brief changed since it started, then the queued tasks ready to start and those waiting, running each one's check; --started lists the running and in-review tasks alone and runs no check, and with --brief-under <dir> lists them only when one's brief sits under that directory; --project <id> lists only that project's tasks; --full prints every field of each task",
  run(args, runtime) {
    const { positionals, values } = parsed(this, args, {
      started: { type: "boolean" },
      "brief-under": { type: "string" },
      project: { type: "string" },
      full: { type: "boolean" },
    });
    noArguments(this, positionals);
    const started = values.started === true;
    const briefUnder = optionalValue(this, values, "brief-under");
    if (briefUnder !== null && !started) refuseArguments(this, "--brief-under takes --started");
    const dir = briefUnder === null ? null : resolve(runtime.cwd, briefUnder);
    const project = optionalValue(this, values, "project");
    const view = viewOf(values);
    return withContext(runtime, (context) => {
      if (dir !== null) return startedListingView(listStartedUnder(context, dir, project), view);
      if (started) return startedListingView(listStarted(context, project), view);
      return listingView(list(context, project), view);
    });
  },
};

const stopCommand: Command = {
  name: "stop",
  usage: USAGE.stop,
  summary:
    "take a running or in-review task back to queued, freeing its brief and keeping its goal, plan, priority and waits",
  run(args, runtime) {
    const name = oneName(this, parsed(this, args, {}).positionals);
    return withContext(runtime, (context) => stop(context, name));
  },
};

const doneCommand: Command = {
  name: "done",
  usage: USAGE.done,
  summary: "remove a task, however its work ended",
  run(args, runtime) {
    const name = oneName(this, parsed(this, args, {}).positionals);
    return withContext(runtime, (context) => done(context, name));
  },
};

const PROJECT_ACTS = ["add", "list", "remove"] as const;

type ProjectAct = (typeof PROJECT_ACTS)[number];

function projectAct(command: Command, act: string | undefined): ProjectAct {
  const known = PROJECT_ACTS.find((candidate) => candidate === act);
  if (known === undefined) refuseArguments(command, `takes add, list or remove, and got: ${act ?? "none"}`);
  return known;
}

function oneId(command: Command, positionals: readonly string[]): string {
  const [id, ...rest] = positionals;
  if (id === undefined || rest.length > 0)
    refuseArguments(command, `takes one project id, and got: ${positionals.join(" ") || "none"}`);
  return id;
}

const projectCommand: Command = {
  name: "project",
  usage: [PROJECT_USAGE.add, PROJECT_USAGE.list, PROJECT_USAGE.remove].join(" | "),
  summary:
    "add a project, its readable name, its repository and the directory of its briefs and plans, replacing them on an id the store holds; list the projects; or remove one no task belongs to",
  run(args, runtime) {
    const [first, ...rest] = args;
    const act = projectAct(this, first);
    switch (act) {
      case "add": {
        const { positionals, values } = parsed(this, rest, {
          name: { type: "string" },
          repo: { type: "string" },
          dir: { type: "string" },
        });
        const id = oneId(this, positionals);
        const name = oneValue(this, values, "name");
        const repo = resolve(runtime.cwd, oneValue(this, values, "repo"));
        const dir = resolve(runtime.cwd, oneValue(this, values, "dir"));
        return withContext(runtime, (context) => addProject(context, { id, name, repo, dir }));
      }
      case "list":
        noArguments(this, parsed(this, rest, {}).positionals);
        return withContext(runtime, (context) => projectsView(listProjects(context)));
      case "remove": {
        const id = oneId(this, parsed(this, rest, {}).positionals);
        return withContext(runtime, (context) => dropProject(context, id));
      }
      default:
        return unreachable(act);
    }
  },
};

const doctorCommand: Command = {
  name: "doctor",
  usage: DOCTOR_USAGE,
  summary:
    "report what agent-task and its plugin need in order to work, naming the fix for each failure; --full prints every check with its fix",
  run(args, runtime) {
    const { positionals, values } = parsed(this, args, { full: { type: "boolean" } });
    noArguments(this, positionals);
    const checks = doctor({
      storePath: storePath(runtime.env),
      busyWaitMs: runtime.busyWaitMs,
      processEnv: runtime.processEnv,
      searchPath: runtime.searchPath,
    });
    const report = doctorView(checks, viewOf(values));
    return { value: report, status: report.counts.fail === 0 ? 0 : 1 };
  },
};

const haltCommand: Command = {
  name: "halt",
  usage: HALT_USAGE.halt,
  summary:
    "halt all agent work on this machine, recording the reason, until the owner runs resume; while a halt is raised, add, start, wait, map, project add and project remove are refused, and so are the plugin's gated tools; on a raised halt, print it unchanged",
  run(args, runtime) {
    const reason = oneReason(this, parsed(this, args, {}).positionals);
    return { value: { halt: raiseHalt(haltPath(runtime.env), reason, runtime.now()) }, status: 0 };
  },
};

const resumeCommand: Command = {
  name: "resume",
  usage: HALT_USAGE.resume,
  summary: "lift the halt, the owner's act, printing the halt as it was, or none when none was raised",
  run(args, runtime) {
    noArguments(this, parsed(this, args, {}).positionals);
    return { value: { halt: liftHalt(haltPath(runtime.env)) }, status: 0 };
  },
};

const haltedCommand: Command = {
  name: "halted",
  usage: HALT_USAGE.halted,
  summary:
    "print that no halt is raised, or while one is, refuse halted naming its reason; a halt recorded but unreadable counts as raised",
  run(args, runtime) {
    noArguments(this, parsed(this, args, {}).positionals);
    return { value: { halt: haltedNow(haltPath(runtime.env)) }, status: 0 };
  },
};

export const COMMANDS: readonly Command[] = [
  addCommand,
  startCommand,
  waitCommand,
  mapCommand,
  reviewCommand,
  listCommand,
  stopCommand,
  doneCommand,
  projectCommand,
  haltCommand,
  resumeCommand,
  haltedCommand,
  doctorCommand,
];
