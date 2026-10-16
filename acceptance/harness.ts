import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

export type RunOptions = { readonly env?: Env; readonly unset?: readonly string[] };

function environment(w: World, { env, unset }: RunOptions): Env {
  return Object.fromEntries(Object.entries({ ...w.env, ...env }).filter(([name]) => !unset?.includes(name)));
}

function launcher(bin: string): void {
  const path = join(bin, "agent-task");
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${ENTRY}" "$@"\n`);
  chmodSync(path, 0o755);
}

export function binWith(w: World, programs: readonly string[], cli: boolean, name = "bin"): string {
  const bin = join(w.root, name);
  mkdirSync(bin);
  for (const program of programs)
    symlinkSync(execFileSync("which", [program], { encoding: "utf8" }).trim(), join(bin, program));
  if (cli) launcher(bin);
  return bin;
}

export function run(w: World, cwd: string, args: readonly string[], options: RunOptions = {}): Ran {
  const ran = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: environment(w, options),
  });
  return { exitCode: ran.status ?? -1, stdout: ran.stdout, stderr: ran.stderr };
}

async function runAsync(w: World, cwd: string, args: readonly string[]): Promise<Ran> {
  const child = Bun.spawn([process.execPath, ENTRY, ...args], {
    cwd,
    env: environment(w, {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function runAtOnce(
  w: World,
  cwd: string,
  runs: readonly (readonly string[])[],
): Promise<readonly Ran[]> {
  return Promise.all(runs.map((args) => runAsync(w, cwd, args)));
}

export type Shown = Readonly<Record<string, unknown>>;

export function result(ran: Ran): Shown {
  expectExit(ran, 0);
  const printed: { readonly result: Shown } = JSON.parse(ran.stdout);
  return printed.result;
}

export function listedTasks(ran: Ran): readonly Shown[] {
  expectExit(ran, 0);
  const printed: { readonly result: { readonly tasks: readonly Shown[] } } = JSON.parse(ran.stdout);
  return printed.result.tasks;
}

export function refusal(ran: Ran): {
  readonly code: string;
  readonly meta: unknown;
  readonly resolve: string;
} {
  expectExit(ran, 1);
  return JSON.parse(ran.stderr).error;
}

function expectExit(ran: Ran, status: number): void {
  if (ran.exitCode !== status)
    throw new Error(`expected exit ${status}, got ${ran.exitCode}: ${ran.stdout}${ran.stderr}`);
}

export function git(w: World, cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe", env: w.env }).trim();
}

export function commit(w: World, repo: string, file: string): string {
  writeFileSync(join(repo, file), `${file}\n`);
  git(w, repo, ["add", file]);
  git(w, repo, ["commit", "-q", "-m", file]);
  return git(w, repo, ["rev-parse", "HEAD"]);
}

export function repo(w: World, name = "repo"): string {
  const dir = join(w.root, name);
  mkdirSync(dir);
  git(w, dir, ["init", "-q", "-b", "main"]);
  commit(w, dir, "first");
  return dir;
}

export function origin(w: World, dir: string, name = "origin.git"): string {
  const bare = join(w.root, name);
  git(w, w.root, ["init", "-q", "--bare", "-b", "main", bare]);
  git(w, dir, ["remote", "add", "origin", bare]);
  git(w, dir, ["push", "-q", "origin", "main"]);
  return bare;
}

export function brief(dir: string, name = "brief.md", text = "# Brief\n"): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}
