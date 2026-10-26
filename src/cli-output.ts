import { writeSync } from "node:fs";
import { encode } from "@toon-format/toon";
import type { ResultStatus } from "./cli-contract";
import { EXIT_STATUS, recordOf } from "./coded-error";

const STDOUT = 1;

const STDERR = 2;

export function exitWithResult(command: string, value: unknown, status: ResultStatus): never {
  writeSync(STDOUT, `${encode({ command, ok: true, result: value ?? null })}\n`);
  return process.exit(status);
}

export function exitWithVersion(version: string): never {
  writeSync(STDOUT, `${version}\n`);
  return process.exit(0);
}

export function exitWithError(command: string, error: unknown): never {
  const record = recordOf(error);
  writeSync(STDERR, `${encode({ command, ok: false, error: record })}\n`);
  return process.exit(EXIT_STATUS[record.kind]);
}
