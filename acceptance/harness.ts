import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

const MANIFEST = join(import.meta.dir, "..", "package.json");

const BUILD_COMPILED = join(import.meta.dir, "..", "scripts", "build-compiled.sh");

export const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const RELEASE_DOWNLOADS = "https://github.com/cniska/agent-task/releases/latest/download";

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

export function runProgram(
  w: World,
  cwd: string,
  program: string,
  args: readonly string[],
  options: RunOptions = {},
): Ran {
  const ran = spawnSync(program, args, { cwd, encoding: "utf8", env: environment(w, options) });
  return { exitCode: ran.status ?? -1, stdout: ran.stdout, stderr: ran.stderr };
}

export function run(w: World, cwd: string, args: readonly string[], options: RunOptions = {}): Ran {
  return runProgram(w, cwd, process.execPath, [ENTRY, ...args], options);
}

export function shell(w: World, cwd: string, script: string, options: RunOptions = {}): Ran {
  return runProgram(w, cwd, "sh", ["-c", script], options);
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

export type Listing = {
  readonly tasks: readonly Shown[];
  readonly ready: readonly Shown[];
  readonly waiting: readonly Shown[];
};

export function listing(ran: Ran): Listing {
  expectExit(ran, 0);
  const printed: { readonly result: Listing } = JSON.parse(ran.stdout);
  return printed.result;
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

function commit(w: World, repo: string, file: string): string {
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

export function brief(dir: string, name = "brief.md", text = "# Brief\n"): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

export function compiledBinary(w: World, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, "agent-task");
  const built = runProgram(w, dir, "bash", [BUILD_COMPILED, binary], {
    env: { PATH: `${dirname(process.execPath)}:${SYSTEM_PATH}` },
  });
  if (built.exitCode !== 0) throw new Error(`build-compiled.sh exited ${built.exitCode}: ${built.stderr}`);
  return binary;
}

export function releaseAssets(w: World, dir: string, binary: string, target: string): string {
  mkdirSync(dir, { recursive: true });
  const tarball = join(dir, `agent-task-${target}.tar.gz`);
  const packed = runProgram(w, dir, "tar", ["-czf", tarball, "-C", dirname(binary), basename(binary)]);
  if (packed.exitCode !== 0) throw new Error(`tar exited ${packed.exitCode}: ${packed.stderr}`);
  const digest = new Bun.CryptoHasher("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(join(dir, `agent-task-${target}.sha256`), `${digest}  agent-task-${target}.tar.gz\n`);
  return dir;
}

export function curlServing(bin: string, assets: string): string {
  mkdirSync(bin, { recursive: true });
  const curl = join(bin, "curl");
  writeFileSync(
    curl,
    [
      "#!/bin/sh",
      "url=; out=",
      'while [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; https://*) url="$1" ;; esac; shift; done',
      `file="${assets}/\${url##*/}"`,
      `case "$url" in ${RELEASE_DOWNLOADS}/*) ;; *) exit 22 ;; esac`,
      '[ -f "$file" ] || exit 22',
      'cp "$file" "$out"',
      "",
    ].join("\n"),
  );
  chmodSync(curl, 0o755);
  return bin;
}

export function jsonLine(text: string): unknown {
  const lines = text.split("\n");
  if (lines.length !== 2 || lines[1] !== "") throw new Error(`expected one JSON line, got: ${text}`);
  return JSON.parse(lines[0] ?? "");
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

export function packageVersion(): string {
  const version = field(JSON.parse(readFileSync(MANIFEST, "utf8")), "version");
  if (typeof version !== "string") throw new Error(`${MANIFEST} names no version`);
  return version;
}
