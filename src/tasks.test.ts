import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  brief,
  commit,
  git,
  named,
  removeScratchDirs,
  repo,
  scratchDir,
  withOrigin,
} from "./repo.test-support";
import { openStore, taskByName } from "./store";
import { type Context, done, drop, list, start } from "./tasks";

afterAll(removeScratchDirs);

const STARTED = new Date("2026-10-16T10:00:00.000Z");

const ENDED = new Date("2026-10-16T11:00:00.000Z");

function context(at: Date = STARTED): Context {
  return { store: openStore(join(scratchDir(), "tasks.db"), 0), processEnv: process.env, now: () => at };
}

function later(ctx: Context): Context {
  return { ...ctx, now: () => ENDED };
}

function started(ctx: Context, name = "task-a") {
  const dir = repo();
  return { dir, task: start(ctx, { name, repo: dir, brief: brief(dir) }) };
}

describe("start", () => {
  test("records the repository's main working tree, the brief, its blob sha and the time", () => {
    const ctx = context();
    const dir = repo();
    mkdirSync(join(dir, "sub"));
    const path = brief(dir, "hello\n");
    expect(start(ctx, { name: "task-a", repo: join(dir, "sub"), brief: path })).toEqual({
      name: named("task-a"),
      state: "running",
      repo: dir,
      brief: path,
      briefSha: "ce013625030ba8dba906f756967f9e9ca394464a",
      started: "2026-10-16T10:00:00.000Z",
    });
  });

  test("records the main working tree when given a linked worktree", () => {
    const ctx = context();
    const dir = repo();
    const linked = join(scratchDir(), "linked");
    git(dir, ["worktree", "add", "-q", "-b", "topic", linked]);
    expect(start(ctx, { name: "task-a", repo: linked, brief: brief(dir) }).repo).toBe(dir);
  });

  test("refuses a name that is not kebab-case, recording nothing", () => {
    const ctx = context();
    const dir = repo();
    for (const name of ["", "Task", "task_a", "-a", "a-", "a--b", "a b", "a/b", "ä"])
      expect(() => start(ctx, { name, repo: dir, brief: brief(dir) })).toThrow(
        expect.objectContaining({ code: "invalid_name", meta: { name } }),
      );
    expect(list(ctx)).toEqual([]);
  });

  test("refuses a repo that is no checkout and a brief that is no file, recording nothing", () => {
    const ctx = context();
    const dir = repo();
    const outside = scratchDir();
    expect(() => start(ctx, { name: "a", repo: outside, brief: brief(dir) })).toThrow(
      expect.objectContaining({ code: "not_a_checkout" }),
    );
    const unreadable = brief(scratchDir());
    chmodSync(unreadable, 0o000);
    for (const path of [join(dir, "missing.md"), dir, unreadable])
      expect(() => start(ctx, { name: "a", repo: dir, brief: path })).toThrow(
        expect.objectContaining({ code: "brief_unreadable", meta: { brief: path } }),
      );
    expect(taskByName(ctx.store, named("a"))).toBeNull();
  });

  test("refuses a name the store holds in any state, naming the state and what it admits, and changes nothing", () => {
    const ctx = context();
    const { dir, task } = started(ctx, "running-one");
    start(ctx, { name: "dropped-one", repo: dir, brief: brief(dir) });
    drop(ctx, "dropped-one", "given up");
    const again = (name: string) => () =>
      start(later(ctx), { name, repo: dir, brief: brief(dir, "other\n") });
    expect(again("running-one")).toThrow(
      expect.objectContaining({
        code: "name_taken",
        meta: {
          name: "running-one",
          state: "running",
          admits: [
            "agent-task done running-one --commit <sha>...",
            "agent-task drop running-one --reason <text>",
          ],
        },
        resolve:
          "running-one is running, which admits: agent-task done running-one --commit <sha>...; agent-task drop running-one --reason <text>",
      }),
    );
    expect(again("dropped-one")).toThrow(
      expect.objectContaining({
        code: "name_taken",
        meta: { name: "dropped-one", state: "dropped", admits: [] },
        resolve: "dropped-one is dropped, which is final; start new work under another name",
      }),
    );
    expect(taskByName(ctx.store, named("running-one"))).toEqual(task);
  });
});

describe("list", () => {
  test("lists the running tasks oldest first, flagging a brief whose content changed, that is gone or that cannot be read", () => {
    const ctx = context();
    const a = started(ctx, "task-a");
    const b = started(later(ctx), "task-b");
    const c = started(later(ctx), "task-c");
    started(later(ctx), "task-d");
    const e = started(later(ctx), "task-e");
    drop(ctx, "task-d", "worker died");
    writeFileSync(b.task.brief, "# Brief\n\nAmended.\n");
    rmSync(c.task.brief);
    chmodSync(e.task.brief, 0o000);
    expect(list(ctx).map(({ name, briefChanged }) => [name, briefChanged])).toEqual([
      [named("task-a"), false],
      [named("task-b"), true],
      [named("task-c"), true],
      [named("task-e"), true],
    ]);
    expect(list(ctx)[0]).toEqual({ ...a.task, briefChanged: false });
  });
});

describe("drop", () => {
  test("drops a running task with its reason and the time, and refuses one that is not running or unknown", () => {
    const ctx = context();
    const { task } = started(ctx);
    expect(drop(later(ctx), "task-a", "worker died")).toEqual({
      ...task,
      state: "dropped",
      ended: "2026-10-16T11:00:00.000Z",
      reason: "worker died",
    });
    expect(() => drop(ctx, "task-a", "again")).toThrow(
      expect.objectContaining({
        code: "not_running",
        meta: { name: "task-a", act: "drop", state: "dropped", admits: [] },
      }),
    );
    expect(() => drop(ctx, "task-b", "x")).toThrow(
      expect.objectContaining({
        code: "unknown_task",
        resolve: "agent-task start task-b --repo <path> --brief <file>",
      }),
    );
    expect(taskByName(ctx.store, named("task-a"))).toMatchObject({ reason: "worker died" });
  });
});

describe("done", () => {
  test("closes a running task once each commit is reachable from origin's default branch, storing full shas once", () => {
    const ctx = context();
    const { dir, task } = started(ctx);
    withOrigin(dir);
    const landed = commit(dir, "work");
    git(dir, ["push", "-q", "origin", "main"]);
    expect(done(later(ctx), "task-a", [landed.slice(0, 12), landed.toUpperCase(), landed])).toEqual({
      ...task,
      state: "done",
      ended: "2026-10-16T11:00:00.000Z",
      commits: [landed],
    });
    expect(list(ctx)).toEqual([]);
  });

  test("refuses commits that are unknown or not reachable, naming each, and leaves the task running", () => {
    const ctx = context();
    const { dir } = started(ctx);
    withOrigin(dir);
    const landed = git(dir, ["rev-parse", "HEAD"]);
    const unpushed = commit(dir, "unpushed");
    const unknown = "0".repeat(40);
    expect(() => done(ctx, "task-a", [landed, unpushed, unknown])).toThrow(
      expect.objectContaining({
        code: "not_landed",
        meta: { name: "task-a", branch: "origin/main", unknown: [unknown], unmerged: [unpushed] },
      }),
    );
    expect(taskByName(ctx.store, named("task-a"))).toMatchObject({ state: "running" });
    git(dir, ["push", "-q", "origin", "main"]);
    expect(done(ctx, "task-a", [landed, unpushed])).toMatchObject({ commits: [landed, unpushed] });
  });

  test("refuses a task whose repository is gone or has no origin, naming the acts left", () => {
    const ctx = context();
    const { dir } = started(ctx);
    const head = git(dir, ["rev-parse", "HEAD"]);
    expect(() => done(ctx, "task-a", [head])).toThrow(expect.objectContaining({ code: "no_origin" }));
    const moved = join(scratchDir(), "moved");
    renameSync(dir, moved);
    expect(() => done(ctx, "task-a", [head])).toThrow(
      expect.objectContaining({ code: "repo_missing", meta: { name: "task-a", repo: dir } }),
    );
    expect(taskByName(ctx.store, named("task-a"))).toMatchObject({ state: "running" });
  });

  test("refuses a commit given by anything but its sha before reaching git, naming each, and leaves the task running", () => {
    const ctx = context();
    const { dir } = started(ctx);
    const head = git(dir, ["rev-parse", "HEAD"]);
    expect(() => done(ctx, "task-a", [head, "HEAD", "origin/main", "abc"])).toThrow(
      expect.objectContaining({
        code: "invalid_sha",
        meta: { name: "task-a", values: ["HEAD", "origin/main", "abc"] },
      }),
    );
    expect(taskByName(ctx.store, named("task-a"))).toMatchObject({ state: "running" });
  });

  test("refuses an invalid name for drop and done as it does for start", () => {
    const ctx = context();
    expect(() => drop(ctx, "Task_A", "gone")).toThrow(
      expect.objectContaining({ code: "invalid_name", meta: { name: "Task_A" } }),
    );
    expect(() => done(ctx, "Task_A", ["abc"])).toThrow(
      expect.objectContaining({ code: "invalid_name", meta: { name: "Task_A" } }),
    );
  });

  test("refuses a task that is not running or unknown before reaching any remote", () => {
    const ctx = context();
    const { dir } = started(ctx);
    drop(ctx, "task-a", "given up");
    rmSync(dir, { recursive: true });
    expect(() => done(ctx, "task-a", ["abcd"])).toThrow(
      expect.objectContaining({
        code: "not_running",
        meta: { name: "task-a", act: "done", state: "dropped", admits: [] },
      }),
    );
    expect(() => done(ctx, "task-b", ["abcd"])).toThrow(expect.objectContaining({ code: "unknown_task" }));
  });

  test("closes a task started from a linked worktree after that worktree is removed", () => {
    const ctx = context();
    const dir = repo();
    withOrigin(dir);
    const linked = join(scratchDir(), "linked");
    git(dir, ["worktree", "add", "-q", "-b", "topic", linked]);
    start(ctx, { name: "task-a", repo: linked, brief: brief(dir) });
    const work = commit(linked, "work");
    git(linked, ["push", "-q", "origin", "topic:main"]);
    git(dir, ["worktree", "remove", linked]);
    expect(done(ctx, "task-a", [work])).toMatchObject({ state: "done", commits: [work] });
  });
});
