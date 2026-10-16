import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { doctor } from "./doctor";
import { brief, git, named, removeScratchDirs, repo, scratchDir } from "./repo.test-support";
import { closeStore, insertQueued, insertRunning, openStore } from "./store";

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

function storeWith(dir: string, briefPath: string | null, plan: string | null = null): string {
  const path = join(scratchDir(), "tasks.db");
  const store = openStore(path, 0);
  const queued = {
    name: named("task-a"),
    repo: dir,
    goal: null,
    plan,
    priority: null,
    waits: null,
    added: "2026-10-16T10:00:00.000Z",
  };
  if (briefPath === null) insertQueued(store, { ...queued, after: [] });
  else
    insertRunning(store, {
      ...queued,
      brief: briefPath,
      briefSha: "abc",
      session: null,
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
    expect(checkOf(absent, [GIT_DIR], "store")).toEqual({
      name: "store",
      state: "ok",
      detail: `no store at ${absent} yet; add or start creates it`,
      fix: null,
    });
    expect(existsSync(dirname(absent))).toBe(false);
    const directory = join(scratchDir(), "tasks.db");
    mkdirSync(directory);
    const store = checkOf(directory, [GIT_DIR], "store");
    expect(store.state).toBe("fail");
    expect(store.fix).toBe(`stop and hand this error to the owner: ${directory} must be an agent-task store`);
  });

  test("warns a version-1 store without changing it, naming list as the migration", () => {
    const path = join(scratchDir(), "tasks.db");
    const db = new Database(path);
    db.run("PRAGMA user_version = 1");
    db.close();
    const bytes = readFileSync(path);
    expect(checkOf(path, [GIT_DIR], "store")).toEqual({
      name: "store",
      state: "warn",
      detail: `${path} is a version 1 store; this agent-task reads version 2`,
      fix: "run agent-task list, which migrates it, then run agent-task doctor again",
    });
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  test("passes a repository that is its own main working tree, origin or not, and warns one that is no checkout, naming done", () => {
    const dir = repo();
    const store = storeWith(dir, brief(scratchDir()));
    expect(checkOf(store, [GIT_DIR], "task-a repository")).toEqual({
      name: "task-a repository",
      state: "ok",
      detail: `${dir} is its own main working tree`,
      fix: null,
    });
    const bare = join(scratchDir(), "bare.git");
    git(scratchDir(), ["init", "-q", "--bare", bare]);
    const check = checkOf(storeWith(bare, brief(scratchDir())), [GIT_DIR], "task-a repository");
    expect(check.state).toBe("warn");
    expect(check.detail).toContain(bare);
    expect(check.fix).toBe(`put the repository back at ${bare}, or agent-task done task-a`);
  });

  test("checks a queued task's repository and no brief, and a running task's brief, naming stop", () => {
    const dir = scratchDir();
    const queued = report(storeWith(dir, null), [GIT_DIR]).checks;
    expect(queued.find(({ name }) => name === "task-a repository")?.state).toBe("warn");
    expect(queued.find(({ name }) => name === "task-a brief")).toBeUndefined();
    const running = checkOf(storeWith(repo(), join(dir, "missing.md")), [GIT_DIR], "task-a brief");
    expect(running).toMatchObject({
      state: "warn",
      fix: `put the brief back at ${join(dir, "missing.md")}, or agent-task stop task-a`,
    });
  });

  test("checks a task's plan only when it has one, warning on one it cannot read and naming add again", () => {
    const dir = repo();
    const none = report(storeWith(dir, null), [GIT_DIR]).checks;
    expect(none.find(({ name }) => name === "task-a plan")).toBeUndefined();
    const plan = brief(scratchDir(), "plan\n");
    expect(checkOf(storeWith(dir, null, plan), [GIT_DIR], "task-a plan")).toEqual({
      name: "task-a plan",
      state: "ok",
      detail: `${plan} is readable`,
      fix: null,
    });
    const missing = join(scratchDir(), "missing.md");
    expect(checkOf(storeWith(dir, brief(dir), missing), [GIT_DIR], "task-a plan")).toEqual({
      name: "task-a plan",
      state: "warn",
      detail: `${missing} is not a readable file`,
      fix: `put the plan back at ${missing}, or agent-task add task-a --repo <path> --goal <text> [--plan <file>] [--priority urgent|high|medium|low] [--after <name>]... [--waits <text>] again with another --plan or none`,
    });
  });

  test("fails a repository that is gone, naming done", () => {
    const dir = join(scratchDir(), "gone");
    const check = checkOf(storeWith(dir, brief(scratchDir())), [GIT_DIR], "task-a repository");
    expect(check).toMatchObject({
      state: "fail",
      fix: `put the repository back at ${dir}, or agent-task done task-a`,
    });
  });

  test("names hook files that the plugin ships", () => {
    const detail = checkOf(join(scratchDir(), "tasks.db"), [], "jq").detail;
    for (const hook of ["before-edit.sh", "session-start.sh"]) {
      expect(detail).toContain(hook);
      expect(existsSync(join(PLUGIN_HOOKS, hook))).toBe(true);
    }
  });
});
