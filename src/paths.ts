import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

export type Env = {
  readonly home: string | null;
  readonly dataHome: string | null;
  readonly stateHome: string | null;
};

const DATA_NAME = "agent-task";

const STORE_FILE = "tasks.db";

const HALT_FILE = "halt.json";

const UPDATE_CHECK_FILE = "update-check.json";

const LIMITS_FILE = "limits.json";

function homeDir(env: Env): string {
  return env.home ?? userInfo().homedir;
}

export function dataDir(env: Env): string {
  if (env.dataHome !== null && isAbsolute(env.dataHome)) return join(env.dataHome, DATA_NAME);
  return join(homeDir(env), ".local", "share", DATA_NAME);
}

function stateDir(env: Env): string {
  if (env.stateHome !== null && isAbsolute(env.stateHome)) return join(env.stateHome, DATA_NAME);
  return join(homeDir(env), ".local", "state", DATA_NAME);
}

export function storePath(env: Env): string {
  return join(dataDir(env), STORE_FILE);
}

export function haltPath(env: Env): string {
  return join(dataDir(env), HALT_FILE);
}

export function limitsPath(env: Env): string {
  return join(dataDir(env), LIMITS_FILE);
}

export function updateCheckPath(env: Env): string {
  return join(stateDir(env), UPDATE_CHECK_FILE);
}

export function curlInstallPath(env: Env): string {
  return join(homeDir(env), ".local", "bin", DATA_NAME);
}
