#!/usr/bin/env bun
import { resolve } from "node:path";
import { version } from "../package.json";
import { COMMANDS } from "./cli-commands";
import { type Command, type Outcome, type Runtime, usageError } from "./cli-contract";
import { exitWithError, exitWithResult, exitWithVersion } from "./cli-output";

const PROGRAM = "agent-task";

const VERSION_FLAG = "--version";

const VERSION_USAGE = `${PROGRAM} ${VERSION_FLAG}`;

const BUSY_WAIT_MS = 5000;

const FLAGS = [{ name: VERSION_FLAG, usage: VERSION_USAGE, summary: "print the version alone on one line" }];

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
  now: () => new Date(),
};

const [name, ...args] = process.argv.slice(2);

if (name === undefined || name === "--help")
  exitWithResult(
    PROGRAM,
    {
      commands: COMMANDS.map(({ name, usage, summary }) => ({ name, usage, summary })),
      flags: FLAGS,
    },
    0,
  );

if (name === VERSION_FLAG) {
  if (args.length > 0)
    exitWithError(
      PROGRAM,
      usageError("wrong_arity", { command: VERSION_FLAG, got: args, usage: VERSION_USAGE }),
    );
  exitWithVersion(version);
}

const command = COMMANDS.find((known) => known.name === name);

if (command === undefined)
  exitWithError(
    PROGRAM,
    usageError("unknown_command", {
      name,
      usage: `${PROGRAM} ${[...COMMANDS.map(({ name }) => name), VERSION_FLAG].join("|")}`,
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
