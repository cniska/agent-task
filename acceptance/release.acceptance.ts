import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  binWith,
  brief,
  compiledBinary,
  curlServing,
  jsonLine,
  packageVersion,
  type Ran,
  releaseAssets,
  removeScratch,
  repo,
  runProgram,
  SYSTEM_PATH,
  shell,
  type World,
  world,
} from "./harness";

afterEach(removeScratch);

const BUILD_TIMEOUT_MS = 60_000;

const INSTALL = join(import.meta.dir, "..", "scripts", "install.sh");

const BUILD_NPM = join(import.meta.dir, "..", "scripts", "build-npm.ts");

const TARGET = `${process.platform}-${process.arch}`;

const OTHER_TARGET = TARGET === "darwin-arm64" ? "linux-x64" : "darwin-arm64";

function installing(w: World, home: string, curl: string): Ran {
  return runProgram(w, home, "/bin/sh", [INSTALL], {
    env: { HOME: home, PATH: `${curl}:${SYSTEM_PATH}`, SHELL: "/bin/zsh" },
  });
}

function unameSaying(w: World, system: string, machine: string): string {
  const dir = join(w.root, "uname-bin");
  mkdirSync(dir);
  const uname = join(dir, "uname");
  writeFileSync(uname, `#!/bin/sh\ncase "$1" in -s) echo '${system}' ;; -m) echo '${machine}' ;; esac\n`);
  chmodSync(uname, 0o755);
  return dir;
}

function fakeBuild(dir: string, printed: string): string {
  const build = join(dir, "agent-task");
  mkdirSync(dir, { recursive: true });
  writeFileSync(build, `#!/bin/sh\nprintf '%s\\n' '${printed}'\n`);
  chmodSync(build, 0o755);
  return build;
}

function managesATask(w: World, path: string): void {
  const dir = repo(w);
  const briefPath = brief(dir);
  const agentTask = (args: readonly string[]): unknown => {
    const ran = runProgram(w, dir, "agent-task", args, { env: { PATH: path } });
    expect([ran.exitCode, ran.stderr]).toEqual([0, ""]);
    return jsonLine(ran.stdout);
  };

  expect(agentTask(["start", "task-a", "--repo", dir, "--brief", briefPath])).toMatchObject({
    command: "start",
    ok: true,
    result: { name: "task-a", repo: dir, brief: briefPath, state: "running" },
  });
  expect(agentTask(["list"])).toMatchObject({
    command: "list",
    ok: true,
    result: { tasks: [{ name: "task-a", briefChanged: false }] },
  });
  expect(agentTask(["done", "task-a"])).toMatchObject({
    command: "done",
    ok: true,
    result: { name: "task-a", state: "running" },
  });
  expect(agentTask(["doctor"])).toMatchObject({ command: "doctor", ok: true, result: { failing: 0 } });
}

test(
  "AC-23 the release binary, alone on PATH with git, prints its version and runs start, list, done and doctor",
  () => {
    const w = world();
    const binary = compiledBinary(w, join(w.root, "build"));
    const path = `${dirname(binary)}:${binWith(w, ["git"], false, "git-bin")}`;

    expect(runProgram(w, w.root, "agent-task", ["--version"], { env: { PATH: path } })).toEqual({
      exitCode: 0,
      stdout: `${packageVersion()}\n`,
      stderr: "",
    });
    managesATask(w, path);
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-24 install.sh installs the latest release after checking its checksum, and installs nothing from a bad download",
  () => {
    const w = world();
    const assets = releaseAssets(w, join(w.root, "assets"), compiledBinary(w, join(w.root, "build")), TARGET);
    const curl = curlServing(join(w.root, "fake-bin"), assets);
    const home = join(w.root, "install-home");
    mkdirSync(home);
    const installed = join(home, ".local", "bin", "agent-task");

    expect(installing(w, home, curl)).toMatchObject({ exitCode: 0, stderr: "" });
    expect(installing(w, home, curl)).toMatchObject({ exitCode: 0, stderr: "" });
    expect(runProgram(w, home, installed, ["--version"])).toEqual({
      exitCode: 0,
      stdout: `${packageVersion()}\n`,
      stderr: "",
    });
    expect(readdirSync(join(home, ".local", "bin"))).toEqual(["agent-task"]);

    writeFileSync(
      join(assets, `agent-task-${TARGET}.sha256`),
      `${"0".repeat(64)}  agent-task-${TARGET}.tar.gz\n`,
    );
    const fresh = join(w.root, "fresh");
    mkdirSync(fresh);
    const refused = installing(w, fresh, curl);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("agent-task install: checksum mismatch for");
    expect(existsSync(join(fresh, ".local"))).toBe(false);

    for (const printed of ["", "1.2.3.4", "../x"]) {
      const mislabelled = join(w.root, `mislabelled-${printed.length}`);
      const served = curlServing(
        join(mislabelled, "bin"),
        releaseAssets(w, join(mislabelled, "assets"), fakeBuild(join(mislabelled, "build"), printed), TARGET),
      );
      const untouched = join(mislabelled, "home");
      mkdirSync(untouched);
      expect(installing(w, untouched, served)).toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining(
          `agent-task install: the downloaded agent-task reports version '${printed}', not x.y.z; this release is broken, so install a later one\n`,
        ),
      });
      expect(readdirSync(untouched)).toEqual([]);
    }
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-25 the npm package runs its platform's binary with no runtime on PATH, and refuses on another platform and when the platform package is missing or cannot start",
  () => {
    const w = world();
    const assets = releaseAssets(w, join(w.root, "assets"), compiledBinary(w, join(w.root, "build")), TARGET);
    cpSync(join(assets, `agent-task-${TARGET}.tar.gz`), join(assets, `agent-task-${OTHER_TARGET}.tar.gz`));
    const tree = join(w.root, "npm");
    const built = runProgram(w, w.root, process.execPath, [BUILD_NPM, assets, tree]);
    expect([built.exitCode, built.stderr]).toEqual([0, ""]);

    const modules = join(w.root, "prefix", "lib", "node_modules", "@cniska");
    mkdirSync(modules, { recursive: true });
    cpSync(join(tree, "agent-task"), join(modules, "agent-task"), { recursive: true });
    const bin = join(w.root, "prefix", "bin");
    mkdirSync(bin);
    symlinkSync(join(modules, "agent-task", "bin", "agent-task"), join(bin, "agent-task"));
    const path = `${bin}:${binWith(w, ["git"], false, "git-bin")}:${SYSTEM_PATH}`;
    for (const runtime of ["node", "bun"])
      expect(shell(w, w.root, `command -v ${runtime}`, { env: { PATH: path } }).exitCode).not.toBe(0);
    const launched = (args: readonly string[], launchPath = path): Ran =>
      runProgram(w, w.root, "agent-task", args, { env: { PATH: launchPath } });

    const unsupported = launched(["--version"], `${unameSaying(w, "Plan9", "mips")}:${path}`);
    expect([unsupported.exitCode, unsupported.stdout]).toEqual([1, ""]);
    expect(jsonLine(unsupported.stderr)).toMatchObject({
      command: "agent-task",
      ok: false,
      error: { kind: "refusal", code: "no_build_for_platform" },
    });

    const missing = launched(["--version"]);
    expect([missing.exitCode, missing.stdout]).toEqual([1, ""]);
    expect(jsonLine(missing.stderr)).toMatchObject({
      command: "agent-task",
      ok: false,
      error: { kind: "refusal", code: "platform_package_missing" },
    });

    const nested = join(modules, "agent-task", "node_modules", "@cniska", `agent-task-${TARGET}`);
    cpSync(join(tree, TARGET), nested, { recursive: true });
    const platformBinary = join(nested, "agent-task");
    chmodSync(platformBinary, 0o644);
    const unstartable = launched(["--version"]);
    expect([unstartable.exitCode, unstartable.stdout]).toEqual([1, ""]);
    expect(jsonLine(unstartable.stderr)).toMatchObject({
      command: "agent-task",
      ok: false,
      error: { kind: "refusal", code: "binary_failed" },
    });
    chmodSync(platformBinary, 0o755);

    expect(launched(["--version"])).toEqual({ exitCode: 0, stdout: `${packageVersion()}\n`, stderr: "" });
    const extra = launched(["--version", "now"]);
    expect([extra.exitCode, extra.stdout]).toEqual([2, ""]);
    expect(jsonLine(extra.stderr)).toMatchObject({
      command: "agent-task",
      ok: false,
      error: { kind: "usage", code: "wrong_arity", resolve: "agent-task --version" },
    });
    managesATask(w, path);
  },
  BUILD_TIMEOUT_MS,
);
