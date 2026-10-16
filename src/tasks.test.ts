import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brief, git, named, removeScratchDirs, repo, scratchDir } from "./repo.test-support";
import { insertQueued, openStore, taskByName } from "./store";
import { type Context, done, list, start, stop } from "./tasks";

afterAll(removeScratchDirs);

const STARTED = new Date("2026-10-16T10:00:00.000Z");

const LATER = new Date("2026-10-16T11:00:00.000Z");

function context(at: Date = STARTED): Context {
  return { store: openStore(join(scratchDir(), "tasks.db"), 0), processEnv: process.env, now: () => at };
}

function later(ctx: Context): Context {
  return { ...ctx, now: () => LATER };
}

function started(ctx: Context, name = "task-a", session: string | null = null) {
  const dir = repo();
  return { dir, task: start(ctx, { name, repo: dir, brief: brief(dir), session }) };
}

describe("start", () => {
  test("records the repository's main working tree, the brief, its blob sha, the session and the time as both added and started", () => {
    const ctx = context();
    const dir = repo();
    mkdirSync(join(dir, "sub"));
    const path = brief(dir, "hello\n");
    expect(start(ctx, { name: "task-a", repo: join(dir, "sub"), brief: path, session: "s1" })).toEqual({
      name: named("task-a"),
      state: "running",
      repo: dir,
      added: "2026-10-16T10:00:00.000Z",
      brief: path,
      briefSha: "ce013625030ba8dba906f756967f9e9ca394464a",
      session: "s1",
      started: "2026-10-16T10:00:00.000Z",
    });
  });

  test("records no session when none is given, and the main working tree when given a linked worktree", () => {
    const ctx = context();
    const dir = repo();
    const linked = join(scratchDir(), "linked");
    git(dir, ["worktree", "add", "-q", "-b", "topic", linked]);
    expect(start(ctx, { name: "task-a", repo: linked, brief: brief(dir), session: null })).toMatchObject({
      repo: dir,
      session: null,
    });
  });

  test("starts a queued task, keeping its added time and taking the repo given", () => {
    const ctx = context();
    const dir = repo();
    insertQueued(ctx.store, { name: named("task-a"), repo: "/elsewhere", added: "2026-10-01T00:00:00.000Z" });
    expect(start(later(ctx), { name: "task-a", repo: dir, brief: brief(dir), session: "s2" })).toMatchObject({
      state: "running",
      repo: dir,
      added: "2026-10-01T00:00:00.000Z",
      started: "2026-10-16T11:00:00.000Z",
      session: "s2",
    });
  });

  test("refuses a name that is not kebab-case, recording nothing", () => {
    const ctx = context();
    const dir = repo();
    for (const name of ["", "Task", "task_a", "-a", "a-", "a--b", "a b", "a/b", "ä"])
      expect(() => start(ctx, { name, repo: dir, brief: brief(dir), session: null })).toThrow(
        expect.objectContaining({ code: "invalid_name", meta: { name } }),
      );
    expect(list(ctx)).toEqual({ tasks: [], ready: [] });
  });

  test("refuses a repo that is no checkout and a brief that is no file, recording nothing", () => {
    const ctx = context();
    const dir = repo();
    const outside = scratchDir();
    expect(() => start(ctx, { name: "a", repo: outside, brief: brief(dir), session: null })).toThrow(
      expect.objectContaining({ code: "not_a_checkout" }),
    );
    const unreadable = brief(scratchDir());
    chmodSync(unreadable, 0o000);
    for (const path of [join(dir, "missing.md"), dir, unreadable])
      expect(() => start(ctx, { name: "a", repo: dir, brief: path, session: null })).toThrow(
        expect.objectContaining({ code: "brief_unreadable", meta: { brief: path } }),
      );
    expect(taskByName(ctx.store, named("a"))).toBeNull();
  });

  test("refuses a running name, naming the state and what it admits, and changes nothing", () => {
    const ctx = context();
    const { dir, task } = started(ctx, "running-one");
    expect(() =>
      start(later(ctx), { name: "running-one", repo: dir, brief: brief(dir, "other\n"), session: null }),
    ).toThrow(
      expect.objectContaining({
        code: "name_taken",
        meta: {
          name: "running-one",
          state: "running",
          admits: ["agent-task stop running-one", "agent-task done running-one"],
        },
        resolve:
          "running-one is running, which admits: agent-task stop running-one; agent-task done running-one",
      }),
    );
    expect(taskByName(ctx.store, named("running-one"))).toEqual(task);
  });
});

describe("list", () => {
  test("lists the running tasks oldest first, flagging a brief whose content changed, that is gone or that cannot be read, and the queued apart", () => {
    const ctx = context();
    const a = started(ctx, "task-a");
    const b = started(later(ctx), "task-b");
    const c = started(later(ctx), "task-c");
    started(later(ctx), "task-d");
    const e = started(later(ctx), "task-e");
    done(ctx, "task-d");
    stop(ctx, "task-e");
    writeFileSync(b.task.brief, "# Brief\n\nAmended.\n");
    rmSync(c.task.brief);
    chmodSync(e.task.brief, 0o000);
    const f = started(later(ctx), "task-f");
    chmodSync(f.task.brief, 0o000);
    const listing = list(ctx);
    expect(listing.tasks.map(({ name, briefChanged }) => [name, briefChanged])).toEqual([
      [named("task-a"), false],
      [named("task-b"), true],
      [named("task-c"), true],
      [named("task-f"), true],
    ]);
    expect(listing.tasks[0]).toEqual({ ...a.task, briefChanged: false });
    expect(listing.ready).toEqual([
      { name: named("task-e"), state: "queued", repo: e.dir, added: "2026-10-16T11:00:00.000Z" },
    ]);
  });
});

describe("stop", () => {
  test("takes a running task back to queued, keeping its added time and repo, and refuses a queued or unknown one", () => {
    const ctx = context();
    const { dir, task } = started(ctx, "task-a", "s1");
    expect(stop(later(ctx), "task-a")).toEqual({
      name: named("task-a"),
      state: "queued",
      repo: dir,
      added: task.added,
    });
    expect(() => stop(ctx, "task-a")).toThrow(
      expect.objectContaining({
        code: "wrong_state",
        meta: {
          name: "task-a",
          act: "stop",
          state: "queued",
          admits: [
            "agent-task start task-a --repo <path> --brief <file> [--session <id>]",
            "agent-task done task-a",
          ],
        },
        resolve:
          "task-a is queued, which admits: agent-task start task-a --repo <path> --brief <file> [--session <id>]; agent-task done task-a",
      }),
    );
    expect(() => stop(ctx, "task-b")).toThrow(
      expect.objectContaining({
        code: "unknown_task",
        meta: { name: "task-b", act: "stop" },
        resolve: "agent-task start task-b --repo <path> --brief <file> [--session <id>]",
      }),
    );
    expect(taskByName(ctx.store, named("task-a"))).toMatchObject({ state: "queued" });
  });
});

describe("done", () => {
  test("removes a running or a queued task, returning it, frees its name, and refuses an unknown one", () => {
    const ctx = context();
    const { dir, task } = started(ctx);
    const moved = join(scratchDir(), "moved");
    renameSync(dir, moved);
    expect(done(ctx, "task-a")).toEqual(task);
    expect(() => done(ctx, "task-a")).toThrow(
      expect.objectContaining({ code: "unknown_task", meta: { name: "task-a", act: "done" } }),
    );
    expect(list(ctx)).toEqual({ tasks: [], ready: [] });
    const again = started(ctx, "task-a");
    stop(ctx, "task-a");
    expect(done(ctx, "task-a")).toMatchObject({ state: "queued", repo: again.dir });
    expect(taskByName(ctx.store, named("task-a"))).toBeNull();
  });

  test("refuses an invalid name for stop and done as it does for start", () => {
    const ctx = context();
    for (const act of [stop, done])
      expect(() => act(ctx, "Task_A")).toThrow(
        expect.objectContaining({ code: "invalid_name", meta: { name: "Task_A" } }),
      );
  });
});
