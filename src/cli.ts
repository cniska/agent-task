#!/usr/bin/env bun
import { resolve } from "node:path";
import { version } from "../package.json";
import { COMMANDS } from "./cli-commands";
import { type Command, type Outcome, type Runtime, usageError } from "./cli-contract";
import { exitWithError, exitWithResult, exitWithVersion } from "./cli-output";

const PROGRAM = "agent-task";

const VERSION_FLAG = "--version";

const HELP_FLAG = "--help";

const LIVE_VIEW = "list";

const BUSY_WAIT_MS = 5000;

const UNTIL_TIMEOUT_MS = 5000;

const FLAGS = [
  { name: HELP_FLAG, usage: `${PROGRAM} ${HELP_FLAG}`, summary: "list the commands and flags" },
  { name: VERSION_FLAG, usage: `${PROGRAM} ${VERSION_FLAG}`, summary: "print the version alone on one line" },
];

function blankToNull(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value;
}

function searchPath(value: string | undefined, cwd: string): readonly string[] {
  return (value ?? "")
    .split(":")
    .filter((entry) => entry !== "")
    .map((entry) => resolve(cwd, entry));
}

const runtime: Runtime = {
  cwd: process.cwd(),
  env: { home: blankToNull(process.env.HOME), dataHome: blankToNull(process.env.XDG_DATA_HOME) },
  processEnv: process.env,
  searchPath: searchPath(process.env.PATH, process.cwd()),
  busyWaitMs: BUSY_WAIT_MS,
  untilTimeoutMs: UNTIL_TIMEOUT_MS,
  now: () => new Date(),
};

const [name = LIVE_VIEW, ...args] = process.argv.slice(2);

const flag = FLAGS.find((known) => known.name === name);

if (flag !== undefined && args.length > 0)
  exitWithError(PROGRAM, usageError("wrong_arity", { command: flag.name, got: args, usage: flag.usage }));

if (name === HELP_FLAG)
  exitWithResult(
    PROGRAM,
    {
      commands: COMMANDS.map(({ name, usage, summary }) => ({ name, usage, summary })),
      flags: FLAGS,
    },
    0,
  );

if (name === VERSION_FLAG) exitWithVersion(version);

const command = COMMANDS.find((known) => known.name === name);

if (command === undefined)
  exitWithError(
    PROGRAM,
    usageError("unknown_command", {
      name,
      usage: `${PROGRAM} ${[...COMMANDS, ...FLAGS].map(({ name }) => name).join("|")}`,
    }),
  );

function ranOrExited(command: Command): Outcome {
  try {
    return command.run(args, runtime);
  } catch (error) {
    return exitWithError(command.name, error);
  }
}

const { value, status } = ranOrExited(command);

exitWithResult(command.name, value, status);
