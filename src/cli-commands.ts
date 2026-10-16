import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Command, type Runtime, usageError } from "./cli-contract";
import { messageOf } from "./coded-error";
import { storePath } from "./paths";
import { closeStore, openStore } from "./store";
import { type Context, done, drop, list, start, USAGE } from "./tasks";

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

function manyValues(
  command: Command,
  values: Parsed["values"],
  flag: string,
): readonly [string, ...string[]] {
  const value = values[flag];
  const all = typeof value === "string" ? [value] : (value ?? []);
  const [first, ...rest] = all;
  if (first === undefined || all.some((one) => one.trim() === ""))
    refuseArguments(command, `needs --${flag} with a value, once or more`);
  return [first, ...rest];
}

function withContext<T>(runtime: Runtime, act: (context: Context) => T): T {
  const store = openStore(storePath(runtime.env), runtime.busyWaitMs);
  try {
    return act({ store, processEnv: runtime.processEnv, now: runtime.now });
  } finally {
    closeStore(store);
  }
}

const startCommand: Command = {
  name: "start",
  usage: USAGE.start,
  summary: "record a running task: its repository, its brief and the brief's content",
  run(args, runtime) {
    const { positionals, values } = parsed(this, args, {
      repo: { type: "string" },
      brief: { type: "string" },
    });
    const name = oneName(this, positionals);
    const repo = resolve(runtime.cwd, oneValue(this, values, "repo"));
    const brief = resolve(runtime.cwd, oneValue(this, values, "brief"));
    return withContext(runtime, (context) => start(context, { name, repo, brief }));
  },
};

const listCommand: Command = {
  name: "list",
  usage: USAGE.list,
  summary: "list the running tasks, flagging each whose brief changed since it started",
  run(args, runtime) {
    const { positionals } = parsed(this, args, {});
    if (positionals.length > 0) refuseArguments(this, `takes no argument, and got: ${positionals.join(" ")}`);
    return withContext(runtime, (context) => ({ tasks: list(context) }));
  },
};

const doneCommand: Command = {
  name: "done",
  usage: USAGE.done,
  summary: "close a running task once each of its commits is on origin's default branch",
  run(args, runtime) {
    const { positionals, values } = parsed(this, args, { commit: { type: "string", multiple: true } });
    const name = oneName(this, positionals);
    const commits = manyValues(this, values, "commit");
    return withContext(runtime, (context) => done(context, name, commits));
  },
};

const dropCommand: Command = {
  name: "drop",
  usage: USAGE.drop,
  summary: "close a running task whose work was given up",
  run(args, runtime) {
    const { positionals, values } = parsed(this, args, { reason: { type: "string" } });
    const name = oneName(this, positionals);
    const reason = oneValue(this, values, "reason");
    return withContext(runtime, (context) => drop(context, name, reason));
  },
};

export const COMMANDS: readonly Command[] = [startCommand, listCommand, doneCommand, dropCommand];
