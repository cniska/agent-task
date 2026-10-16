#!/usr/bin/env bun
import { version } from "../package.json";
import { COMMANDS } from "./cli-commands";
import { type Command, usageError } from "./cli-contract";
import { exitWithError, exitWithResult, exitWithVersion } from "./cli-output";

const PROGRAM = "agent-task";

const VERSION_FLAG = "--version";

const VERSION_USAGE = `${PROGRAM} ${VERSION_FLAG}`;

const FLAGS = [{ name: VERSION_FLAG, usage: VERSION_USAGE, summary: "print the version alone on one line" }];

const [name, ...args] = process.argv.slice(2);

if (name === undefined || name === "--help")
  exitWithResult(PROGRAM, {
    commands: COMMANDS.map(({ name, usage, summary }) => ({ name, usage, summary })),
    flags: FLAGS,
  });

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

function ranOrExited(command: Command): unknown {
  try {
    return command.run(args);
  } catch (error) {
    return exitWithError(command.name, error);
  }
}

exitWithResult(command.name, ranOrExited(command));
