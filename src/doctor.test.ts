import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { doctor } from "./doctor";
import { brief, git, named, removeScratchDirs, repo, scratchDir } from "./repo.test-support";
import { closeStore, insertTask, openStore } from "./store";

afterAll(removeScratchDirs);

const PLUGIN_HOOKS = join(import.meta.dir, "..", "plugin", "hooks");

const GIT_DIR = dirname(Bun.which("git") ?? "/usr/bin/git");

function report(storePath: string, searchPath: readonly string[]) {
  return doctor({ storePath, busyWaitMs: 0, processEnv: process.env, searchPath });
}

function checkOf(storePath: string, searchPath: readonly string[], name: string) {
  const found = report(storePath, searchPath).checks.find((check) => check.name === name);
  if (found === undefined) throw new Error(`no ${name} check`);
  return found;
}

function storeWith(dir: string, briefPath: string): string {
  const path = join(scratchDir(), "tasks.db");
  const store = openStore(path, 0);
  insertTask(store, {
    name: named("task-a"),
    repo: dir,
    brief: briefPath,
    briefSha: "abc",
    started: "2026-10-16T10:00:00.000Z",
  });
  closeStore(store);
  return path;
}

describe("doctor", () => {
  test("finds a program only as an executable file, and names each directory it searched", () => {
    const bin = scratchDir();
    writeFileSync(join(bin, "jq"), "#!/bin/sh\n");
    mkdirSync(join(bin, "realpath"));
    const runnable = scratchDir();
    writeFileSync(join(runnable, "jq"), "#!/bin/sh\n");
    chmodSync(join(runnable, "jq"), 0o755);
    const store = join(scratchDir(), "tasks.db");
    expect(checkOf(store, [bin], "jq")).toMatchObject({ state: "warn" });
    expect(checkOf(store, [bin], "realpath").detail).toStartWith(`not found in ${bin};`);
    expect(checkOf(store, [bin, runnable], "jq")).toEqual({
      name: "jq",
      state: "ok",
      detail: `found at ${join(runnable, "jq")}`,
      fix: null,
    });
  });

  test("says PATH names no directory when it is empty, and fails git", () => {
    const git = checkOf(join(scratchDir(), "tasks.db"), [], "git");
    expect(git.state).toBe("fail");
    expect(git.detail).toStartWith("PATH names no directory;");
  });

  test("passes a store not yet made without making it, and fails one that cannot be opened", () => {
    const absent = join(scratchDir(), "data", "tasks.db");
    expect(checkOf(absent, [GIT_DIR], "store")).toMatchObject({ state: "ok", fix: null });
    expect(existsSync(dirname(absent))).toBe(false);
    const directory = join(scratchDir(), "tasks.db");
    mkdirSync(directory);
    const store = checkOf(directory, [GIT_DIR], "store");
    expect(store.state).toBe("fail");
    expect(store.fix).toBe(`stop and hand this error to the owner: ${directory} must be an agent-task store`);
  });

  test("fails a repository inside a checkout with no origin, as done would refuse it", () => {
    const outer = repo();
    const inner = join(outer, "inner");
    mkdirSync(inner);
    const store = storeWith(inner, brief(scratchDir()));
    expect(checkOf(store, [GIT_DIR], "task-a repository")).toMatchObject({
      state: "fail",
      fix: `add the remote the work lands on as origin in ${inner}, then run the command again`,
    });
    git(outer, ["remote", "add", "origin", join(scratchDir(), "nowhere.git")]);
    expect(checkOf(store, [GIT_DIR], "task-a repository")).toMatchObject({ state: "warn" });
  });

  test("warns a repository with an origin that is no checkout git can confirm, naming drop", () => {
    const bare = join(scratchDir(), "bare.git");
    git(scratchDir(), ["init", "-q", "--bare", bare]);
    git(bare, ["remote", "add", "origin", join(scratchDir(), "nowhere.git")]);
    const store = storeWith(bare, brief(scratchDir()));
    const check = checkOf(store, [GIT_DIR], "task-a repository");
    expect(check.state).toBe("warn");
    expect(check.detail).toContain(bare);
    expect(check.fix).toBe(`put the repository back at ${bare}, or agent-task drop task-a --reason <text>`);
  });

  test("fails a plain directory, which has no origin", () => {
    const dir = scratchDir();
    const store = storeWith(dir, brief(dir));
    expect(checkOf(store, [GIT_DIR], "task-a repository").state).toBe("fail");
  });

  test("names hook files that the plugin ships", () => {
    const detail = checkOf(join(scratchDir(), "tasks.db"), [], "jq").detail;
    for (const hook of ["before-edit.sh", "session-start.sh"]) {
      expect(detail).toContain(hook);
      expect(existsSync(join(PLUGIN_HOOKS, hook))).toBe(true);
    }
  });
});
