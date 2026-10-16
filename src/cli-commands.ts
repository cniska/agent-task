import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Command, type Outcome, type Runtime, usageError } from "./cli-contract";
import { messageOf } from "./coded-error";
import { DOCTOR_USAGE, doctor } from "./doctor";
import { storePath } from "./paths";
import { closeStore, openStore } from "./store";
import { type Context, done, list, start, stop, USAGE } from "./tasks";

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

function withContext(runtime: Runtime, act: (context: Context) => unknown): Outcome {
  const store = openStore(storePath(runtime.env), runtime.busyWaitMs);
  try {
    return { value: act({ store, processEnv: runtime.processEnv, now: runtime.now }), status: 0 };
  } finally {
    closeStore(store);
  }
}

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

const listCommand: Command = {
  name: "list",
  usage: USAGE.list,
  summary: "list the running tasks, flagging each whose brief changed since it started, and the queue",
  run(args, runtime) {
    noArguments(this, parsed(this, args, {}).positionals);
    return withContext(runtime, (context) => list(context));
  },
};

const stopCommand: Command = {
  name: "stop",
  usage: USAGE.stop,
  summary: "take a running task back to queued, freeing its brief",
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
  startCommand,
  listCommand,
  stopCommand,
  doneCommand,
  doctorCommand,
];
