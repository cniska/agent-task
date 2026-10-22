import { spawnSync } from "node:child_process";
import type { ProcessEnv } from "./git";

export type UntilState = "met" | "unmet" | "timed_out" | "failed";

const SHELL = "/bin/sh";

const TIMED_OUT = "ETIMEDOUT";

const FAILED_FROM_STATUS = 126;

function errorCode(error: Error): string | null {
  return "code" in error && typeof error.code === "string" ? error.code : null;
}

export function runCheck(
  command: string,
  repo: string,
  processEnv: ProcessEnv,
  timeoutMs: number,
): UntilState {
  const run = spawnSync(SHELL, ["-c", command], {
    cwd: repo,
    env: processEnv,
    stdio: "ignore",
    timeout: timeoutMs,
  });
  if (run.error) return errorCode(run.error) === TIMED_OUT ? "timed_out" : "failed";
  if (run.status === null) return "failed";
  if (run.status === 0) return "met";
  return run.status < FAILED_FROM_STATUS ? "unmet" : "failed";
}
