import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

export type Env = { readonly home: string | null; readonly dataHome: string | null };

const DATA_NAME = "agent-task";

const STORE_FILE = "tasks.db";

function homeDir(env: Env): string {
  return env.home ?? userInfo().homedir;
}

export function dataDir(env: Env): string {
  if (env.dataHome !== null && isAbsolute(env.dataHome)) return join(env.dataHome, DATA_NAME);
  return join(homeDir(env), ".local", "share", DATA_NAME);
}

export function storePath(env: Env): string {
  return join(dataDir(env), STORE_FILE);
}
