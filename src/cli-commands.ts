import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Command, type Outcome, type Runtime, usageError } from "./cli-contract";
import { messageOf } from "./coded-error";
import { DOCTOR_USAGE, doctor } from "./doctor";
import { storePath } from "./paths";
import { closeStore, isPriority, openStore, type Priority } from "./store";
import { add, type Context, done, list, review, start, stop, USAGE, wait } from "./tasks";

type Flags = Readonly<Record<string, { readonly type: "string"; readonly multiple?: boolean }>>;

type Parsed = {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, string | readonly string[] | undefined>>;
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

function oneValue(command: Command, values: Parsed["values"], flag: string): string {
  const value = values[flag];
  if (typeof value !== "string" || value.trim() === "")
    refuseArguments(command, `needs --${flag} with a value`);
  return value;
}

function optionalValue(command: Command, values: Parsed["values"], flag: string): string | null {
  const value = values[flag];
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "")
    refuseArguments(command, `needs a value after --${flag}`);
  return value;
}

function manyValues(command: Command, values: Parsed["values"], flag: string): readonly string[] {
  const value = values[flag];
  if (value === undefined) return [];
  const list = typeof value === "string" ? [value] : value;
  if (list.some((entry) => entry.trim() === "")) refuseArguments(command, `needs a value after --${flag}`);
  return list;
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

function withContext(runtime: Runtime, act: (context: Context) => unknown): Outcome {
  const store = openStore(storePath(runtime.env), runtime.busyWaitMs);
  try {
    return {
      value: act({
        store,
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
    "queue a task: its repository, goal, plan, priority, what it waits for and the check that says its wait is met; on a queued name, replace them",
  run(args, runtime) {
    const { positionals, values } = parsed(this, args, {
      repo: { type: "string" },
      goal: { type: "string" },
      plan: { type: "string" },
      priority: { type: "string" },
      after: { type: "string", multiple: true },
      waits: { type: "string" },
      until: { type: "string" },
    });
    const name = oneName(this, positionals);
    const repo = resolve(runtime.cwd, oneValue(this, values, "repo"));
    const goal = oneValue(this, values, "goal");
    const planPath = optionalValue(this, values, "plan");
    const plan = planPath === null ? null : resolve(runtime.cwd, planPath);
    const priority = priorityValue(this, values);
    const after = afterNames(this, values, name);
    const waits = optionalValue(this, values, "waits");
    const until = optionalValue(this, values, "until");
    return withContext(runtime, (context) =>
      add(context, { name, repo, goal, plan, priority, after, waits, until }),
    );
  },
};

const startCommand: Command = {
  name: "start",
  usage: USAGE.start,
  summary: "run a task, new or queued: its repository, its brief, the brief's content and the session",
  run(args, runtime) {
    const { positionals, values } = parsed(this, args, {
      repo: { type: "string" },
      brief: { type: "string" },
      session: { type: "string" },
    });
    const name = oneName(this, positionals);
    const repo = resolve(runtime.cwd, oneValue(this, values, "repo"));
    const brief = resolve(runtime.cwd, oneValue(this, values, "brief"));
    const session = optionalValue(this, values, "session");
    return withContext(runtime, (context) => start(context, { name, repo, brief, session }));
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

const reviewCommand: Command = {
  name: "review",
  usage: USAGE.review,
  summary: "record that a running task was handed back for review; its brief stays frozen until stop or done",
  run(args, runtime) {
    const name = oneName(this, parsed(this, args, {}).positionals);
    return withContext(runtime, (context) => review(context, name));
  },
};

const listCommand: Command = {
  name: "list",
  usage: USAGE.list,
  summary:
    "list the running and in-review tasks, flagging each whose brief changed since it started, then the queued tasks ready to start and those waiting, running each one's check",
  run(args, runtime) {
    noArguments(this, parsed(this, args, {}).positionals);
    return withContext(runtime, (context) => list(context));
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

const doctorCommand: Command = {
  name: "doctor",
  usage: DOCTOR_USAGE,
  summary: "report what agent-task and its plugin need in order to work, naming the fix for each failure",
  run(args, runtime) {
    noArguments(this, parsed(this, args, {}).positionals);
    const report = doctor({
      storePath: storePath(runtime.env),
      busyWaitMs: runtime.busyWaitMs,
      processEnv: runtime.processEnv,
      searchPath: runtime.searchPath,
    });
    return { value: report, status: report.failing === 0 ? 0 : 1 };
  },
};

export const COMMANDS: readonly Command[] = [
  addCommand,
  startCommand,
  waitCommand,
  reviewCommand,
  listCommand,
  stopCommand,
  doneCommand,
  doctorCommand,
];
