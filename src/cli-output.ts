import { writeSync } from "node:fs";
import { EXIT_STATUS, recordOf } from "./coded-error";

const STDOUT = 1;

const STDERR = 2;

export function exitWithResult(command: string, value: unknown): never {
  writeSync(STDOUT, `${JSON.stringify({ command, ok: true, result: value ?? null })}\n`);
  return process.exit(0);
}

export function exitWithVersion(version: string): never {
  writeSync(STDOUT, `${version}\n`);
  return process.exit(0);
}

export function exitWithError(command: string, error: unknown): never {
  const record = recordOf(error);
  writeSync(STDERR, `${JSON.stringify({ command, ok: false, error: record })}\n`);
  return process.exit(EXIT_STATUS[record.kind]);
}
