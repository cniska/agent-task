import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

type Env = Readonly<Record<string, string>>;

export type Ran = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

export type World = { readonly root: string; readonly env: Env };

const scratchDirs: string[] = [];

export function removeScratch(): void {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function world(): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-task-acceptance-")));
  scratchDirs.push(root);
  const home = join(root, "home");
  const xdg = { XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_STATE_HOME: "state" };
  for (const dir of [home, ...Object.values(xdg).map((name) => join(root, name))]) mkdirSync(dir);
  return {
    root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      ...Object.fromEntries(Object.entries(xdg).map(([variable, name]) => [variable, join(root, name)])),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "author@example.test",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "author@example.test",
    },
  };
}

export function run(w: World, cwd: string, args: readonly string[]): Ran {
  const ran = spawnSync(process.execPath, [ENTRY, ...args], { cwd, encoding: "utf8", env: w.env });
  return { exitCode: ran.status ?? -1, stdout: ran.stdout, stderr: ran.stderr };
}
