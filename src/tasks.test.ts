import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brief, git, named, removeScratchDirs, repo, scratchDir } from "./repo.test-support";
import { insertQueued, openStore, taskByName } from "./store";
import {
  type AddRequest,
  add,
  type Context,
  done,
  list,
  listStarted,
  listStartedUnder,
  review,
  start,
  stop,
  wait,
} from "./tasks";

afterAll(removeScratchDirs);

const STARTED = new Date("2026-10-16T10:00:00.000Z");

const LATER = new Date("2026-10-16T11:00:00.000Z");

const UNQUEUED = { goal: null, plan: null, priority: null, waits: null };

const EMPTY = { tasks: [], ready: [], waiting: [] };

const CHECK_TIMEOUT_MS = 5000;

const SHORT_CHECK_TIMEOUT_MS = 50;

function context(at: Date = STARTED): Context {
  return {
    store: openStore(join(scratchDir(), "tasks.db"), 0),
    processEnv: process.env,
    now: () => at,
    untilTimeoutMs: CHECK_TIMEOUT_MS,
  };
}

function later(ctx: Context): Context {
  return { ...ctx, now: () => LATER };
}

function started(ctx: Context, name = "task-a", session: string | null = null) {
  const dir = repo();
  return { dir, task: start(ctx, { name, repo: dir, brief: brief(dir), session }) };
}

function request(name: string, dir: string, fields: Partial<AddRequest> = {}): AddRequest {
  return {
    name,
    repo: dir,
    goal: `do ${name}`,
    plan: null,
    priority: null,
    after: [],
    waits: null,
    until: null,
    ...fields,
  };
}

function added(ctx: Context, name: string, fields: Partial<AddRequest> = {}) {
  const dir = repo();
  return { dir, task: add(ctx, request(name, dir, fields)) };
}

describe("add", () => {
  test("queues a task with its main working tree, goal, plan, priority, after, waits, check and the time added", () => {
    const ctx = context();
    const dir = repo();
    mkdirSync(join(dir, "sub"));
    const plan = brief(dir, "plan\n");
    added(ctx, "task-b");
    expect(
      add(ctx, {
        name: "task-a",
        repo: join(dir, "sub"),
        goal: "ship it",
        plan,
        priority: "high",
        after: ["task-b"],
        waits: "the owner's word",
        until: "test -f released",
      }),
    ).toEqual({
      name: named("task-a"),
      state: "queued",
      repo: dir,
      goal: "ship it",
      plan,
      priority: "high",
      waits: "the owner's word",
      added: "2026-10-16T10:00:00.000Z",
      after: [named("task-b")],
      until: "test -f released",
    });
  });

  test("replaces a queued task's record on its name, keeping the time added", () => {
    const ctx = context();
    const { dir } = added(ctx, "task-a", { priority: "low", waits: "nothing yet", until: "exit 1" });
    const other = repo();
    expect(add(later(ctx), request("task-a", other, { goal: "changed", after: [] }))).toEqual({
      name: named("task-a"),
      state: "queued",
      repo: other,
      goal: "changed",
      plan: null,
      priority: null,
      waits: null,
      added: "2026-10-16T10:00:00.000Z",
      after: [],
      until: null,
    });
    expect(dir).not.toBe(other);
  });

  test("refuses a running or in-review name as taken, a plan that is no readable file, an unknown after name, and records nothing", () => {
    const ctx = context();
    const { dir } = started(ctx, "running-one");
    expect(() => add(ctx, request("running-one", dir))).toThrow(
      expect.objectContaining({ code: "name_taken", meta: expect.objectContaining({ state: "running" }) }),
    );
    started(ctx, "review-one");
    review(ctx, "review-one");
    expect(() => add(ctx, request("review-one", dir))).toThrow(
      expect.objectContaining({ code: "name_taken", meta: expect.objectContaining({ state: "review" }) }),
    );
    const unreadable = brief(scratchDir());
    chmodSync(unreadable, 0o000);
    for (const plan of [join(dir, "missing.md"), dir, unreadable])
      expect(() => add(ctx, request("task-a", dir, { plan }))).toThrow(
        expect.objectContaining({ code: "plan_unreadable", meta: { plan } }),
      );
    expect(() => add(ctx, request("task-a", dir, { after: ["task-z"] }))).toThrow(
      expect.objectContaining({
        code: "unknown_task",
        meta: { name: "task-z", act: "add" },
        resolve: "agent-task start task-z --repo <path> --brief <file> [--session <id>]",
      }),
    );
    expect(() => add(ctx, request("task-a", scratchDir()))).toThrow(
      expect.objectContaining({ code: "not_a_checkout" }),
    );
    expect(() => add(ctx, request("Task_A", dir))).toThrow(
      expect.objectContaining({ code: "invalid_name", meta: { name: "Task_A" } }),
    );
    expect(taskByName(ctx.store, named("task-a"))).toBeNull();
  });
});

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
      ...UNQUEUED,
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

  test("starts a queued task, keeping its goal, plan, priority, waits and added time, taking the repo given and dropping what it waited after and its check", () => {
    const ctx = context();
    const dir = repo();
    added(ctx, "task-b");
    done(ctx, "task-b");
    insertQueued(ctx.store, {
      name: named("task-a"),
      repo: "/elsewhere",
      goal: "ship it",
      plan: null,
      priority: "urgent",
      waits: "a word",
      added: "2026-10-01T00:00:00.000Z",
      after: [named("task-b")],
      until: "exit 0",
    });
    const running = start(later(ctx), { name: "task-a", repo: dir, brief: brief(dir), session: "s2" });
    expect(running).toMatchObject({
      state: "running",
      repo: dir,
      goal: "ship it",
      priority: "urgent",
      waits: "a word",
      added: "2026-10-01T00:00:00.000Z",
      started: "2026-10-16T11:00:00.000Z",
      session: "s2",
    });
    expect(Object.keys(running)).not.toContain("until");
    expect(list(ctx).waiting).toEqual([]);
    expect(stop(ctx, "task-a")).toMatchObject({ state: "queued", until: null });
  });

  test("refuses a queued task that waits after a task the store still holds, changing nothing", () => {
    const ctx = context();
    added(ctx, "task-b");
    started(ctx, "task-c");
    const { dir, task } = added(ctx, "task-a", { after: ["task-b", "task-c"] });
    expect(() => start(ctx, { name: "task-a", repo: dir, brief: brief(dir), session: null })).toThrow(
      expect.objectContaining({
        code: "blocked",
        meta: { name: "task-a", after: ["task-b", "task-c"] },
        resolve:
          "agent-task done task-b; agent-task done task-c once each has landed, or agent-task wait task-a [--after <name>]... [--waits <text>] [--until <command>] to wait after fewer",
      }),
    );
    expect(taskByName(ctx.store, named("task-a"))).toEqual(task);
    done(ctx, "task-b");
    done(ctx, "task-c");
    expect(start(ctx, { name: "task-a", repo: dir, brief: brief(dir), session: null })).toMatchObject({
      state: "running",
    });
  });

  test("refuses a name that is not kebab-case, recording nothing", () => {
    const ctx = context();
    const dir = repo();
    for (const name of ["", "Task", "task_a", "-a", "a-", "a--b", "a b", "a/b", "ä"])
      expect(() => start(ctx, { name, repo: dir, brief: brief(dir), session: null })).toThrow(
        expect.objectContaining({ code: "invalid_name", meta: { name } }),
      );
    expect(list(ctx)).toEqual(EMPTY);
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
          admits: [
            "agent-task wait running-one [--after <name>]... [--waits <text>] [--until <command>]",
            "agent-task review running-one",
            "agent-task stop running-one",
            "agent-task done running-one",
          ],
        },
        resolve:
          "running-one is running, which admits: agent-task wait running-one [--after <name>]... [--waits <text>] [--until <command>]; agent-task review running-one; agent-task stop running-one; agent-task done running-one",
      }),
    );
    expect(taskByName(ctx.store, named("running-one"))).toEqual(task);
  });
});

describe("wait", () => {
  test("replaces what a queued task waits after and for and its check, clears all three when given nothing, and sets only waits on a running task", () => {
    const ctx = context();
    added(ctx, "task-b");
    added(ctx, "task-c");
    const { task } = added(ctx, "task-a", { after: ["task-b"], waits: "one thing", until: "exit 1" });
    expect(wait(ctx, { name: "task-a", after: ["task-c"], waits: "another", until: "exit 0" })).toEqual({
      ...task,
      after: [named("task-c")],
      waits: "another",
      until: "exit 0",
    });
    expect(wait(ctx, { name: "task-a", after: [], waits: null, until: null })).toEqual({
      ...task,
      after: [],
      waits: null,
      until: null,
    });
    const running = started(ctx, "task-d").task;
    expect(wait(ctx, { name: "task-d", after: [], waits: "a review", until: null })).toEqual({
      ...running,
      waits: "a review",
    });
  });

  test("refuses --after and --until on a running task, an unknown name and an unknown after name, changing nothing", () => {
    const ctx = context();
    const { task } = started(ctx, "task-d");
    expect(() => wait(ctx, { name: "task-d", after: ["task-d"], waits: null, until: null })).toThrow(
      expect.objectContaining({ code: "wrong_state", meta: expect.objectContaining({ act: "wait" }) }),
    );
    expect(() => wait(ctx, { name: "task-d", after: [], waits: null, until: "exit 0" })).toThrow(
      expect.objectContaining({ code: "wrong_state", meta: expect.objectContaining({ act: "wait" }) }),
    );
    expect(() => wait(ctx, { name: "task-z", after: [], waits: null, until: null })).toThrow(
      expect.objectContaining({ code: "unknown_task", meta: { name: "task-z", act: "wait" } }),
    );
    const queued = added(ctx, "task-a").task;
    expect(() => wait(ctx, { name: "task-a", after: ["task-z"], waits: "x", until: null })).toThrow(
      expect.objectContaining({ code: "unknown_task", meta: { name: "task-z", act: "wait" } }),
    );
    expect(taskByName(ctx.store, named("task-d"))).toEqual(task);
    expect(taskByName(ctx.store, named("task-a"))).toEqual(queued);
  });
});

describe("review", () => {
  test("takes a running task to review, recording the time and keeping the rest, and refuses a task in review, a queued one and an unknown one", () => {
    const ctx = context();
    const { task } = started(ctx, "task-a", "s1");
    const reviewed = review(later(ctx), "task-a");
    expect(reviewed).toEqual({ ...task, state: "review", reviewed: "2026-10-16T11:00:00.000Z" });
    expect(() => review(ctx, "task-a")).toThrow(
      expect.objectContaining({
        code: "wrong_state",
        meta: {
          name: "task-a",
          act: "review",
          state: "review",
          admits: [
            "agent-task wait task-a [--after <name>]... [--waits <text>] [--until <command>]",
            "agent-task stop task-a",
            "agent-task done task-a",
          ],
        },
      }),
    );
    added(ctx, "task-b");
    expect(() => review(ctx, "task-b")).toThrow(
      expect.objectContaining({ code: "wrong_state", meta: expect.objectContaining({ state: "queued" }) }),
    );
    expect(() => review(ctx, "task-c")).toThrow(
      expect.objectContaining({ code: "unknown_task", meta: { name: "task-c", act: "review" } }),
    );
    expect(taskByName(ctx.store, named("task-a"))).toEqual(reviewed);
  });

  test("a task in review refuses start as taken, takes waits, and goes back to queued by stop forgetting the review time", () => {
    const ctx = context();
    const { dir, task } = started(ctx, "task-a");
    review(ctx, "task-a");
    expect(() => start(ctx, { name: "task-a", repo: dir, brief: task.brief, session: null })).toThrow(
      expect.objectContaining({ code: "name_taken", meta: expect.objectContaining({ state: "review" }) }),
    );
    expect(wait(ctx, { name: "task-a", after: [], waits: "the owner", until: null })).toMatchObject({
      state: "review",
      waits: "the owner",
    });
    expect(stop(ctx, "task-a")).toEqual({
      name: named("task-a"),
      state: "queued",
      repo: dir,
      ...UNQUEUED,
      waits: "the owner",
      added: task.added,
      after: [],
      until: null,
    });
  });
});

describe("list", () => {
  test("lists the running and in-review tasks oldest started first, flagging a brief whose content changed, that is gone or that cannot be read, and the queued apart", () => {
    const ctx = context();
    const a = started(ctx, "task-a");
    const b = started(later(ctx), "task-b");
    const c = started(later(ctx), "task-c");
    started(later(ctx), "task-d");
    const e = started(later(ctx), "task-e");
    done(ctx, "task-d");
    stop(ctx, "task-e");
    const reviewed = review(ctx, "task-b");
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
    expect(listing.tasks[1]).toEqual({ ...reviewed, briefChanged: true });
    expect(listing.ready).toEqual([
      {
        name: named("task-e"),
        state: "queued",
        repo: e.dir,
        ...UNQUEUED,
        added: "2026-10-16T11:00:00.000Z",
        after: [],
        until: null,
        untilState: null,
      },
    ]);
    expect(listing.waiting).toEqual([]);
  });

  test("runs each queued task's check in its repository: a met check is ready whatever the text, and one unmet or failed, or met behind a held name, waits", () => {
    const ctx = context();
    const met = added(ctx, "met-with-text", { waits: "a word", until: "exit 0" });
    added(ctx, "unmet", { until: "exit 1" });
    added(ctx, "failed", { until: "exit 127" });
    added(ctx, "met-after", { after: ["unmet"], until: "exit 0" });
    const inRepo = added(ctx, "in-repo", { until: "test -f released" });
    writeFileSync(join(inRepo.dir, "released"), "");
    const listing = list(ctx);
    expect(listing.ready).toEqual([
      { ...inRepo.task, untilState: "met" },
      { ...met.task, untilState: "met" },
    ]);
    expect(listing.waiting.map(({ name, untilState }) => [name, untilState])).toEqual([
      [named("failed"), "failed"],
      [named("met-after"), "met"],
      [named("unmet"), "unmet"],
    ]);
  });

  test("gives a check the timeout passed in, listing one that runs past it as waiting, timed out", () => {
    const ctx = { ...context(), untilTimeoutMs: SHORT_CHECK_TIMEOUT_MS };
    added(ctx, "slow", { until: "sleep 60" });
    const started = Date.now();
    expect(list(ctx).waiting.map(({ name, untilState }) => [name, untilState])).toEqual([
      [named("slow"), "timed_out"],
    ]);
    expect(Date.now() - started).toBeLessThan(CHECK_TIMEOUT_MS);
  });

  test("lists the started tasks alone on request, reading no queued task and running no check", () => {
    const ctx = context();
    const a = started(ctx, "task-a");
    const queued = added(ctx, "marking", { until: ": > marker" });
    const marker = join(queued.dir, "marker");
    expect(listStarted(ctx)).toEqual({ tasks: [{ ...a.task, briefChanged: false }] });
    expect(existsSync(marker)).toBe(false);
    list(ctx);
    expect(existsSync(marker)).toBe(true);
  });

  test("lists every started task from a directory holding one's brief, by its real path, and refuses one holding none", () => {
    const ctx = context();
    const dir = repo();
    const briefs = join(dir, "briefs");
    mkdirSync(briefs);
    start(ctx, { name: "task-a", repo: dir, brief: brief(briefs), session: null });
    started(ctx, "task-b");
    const linked = join(scratchDir(), "linked");
    symlinkSync(dir, linked);
    for (const under of [briefs, dir, linked, "/"])
      expect(listStartedUnder(ctx, under)).toEqual(listStarted(ctx));
    const prefix = join(dir, "brief");
    mkdirSync(prefix);
    for (const under of [prefix, join(dir, "missing"), join(briefs, "brief.md"), scratchDir()])
      expect(() => listStartedUnder(ctx, under)).toThrow(
        expect.objectContaining({ code: "no_brief_under", meta: { dir: under } }),
      );
  });

  test("splits the queued into ready and waiting, each by priority with none last, then added time, then name", () => {
    const ctx = context();
    added(ctx, "low", { priority: "low" });
    added(ctx, "none-b");
    added(ctx, "none-a");
    added(later(ctx), "urgent", { priority: "urgent" });
    added(later(ctx), "early-high", { priority: "high" });
    added(ctx, "waits-word", { priority: "urgent", waits: "a word" });
    added(ctx, "after-low", { after: ["low"] });
    const listing = list(ctx);
    expect(listing.ready.map(({ name }) => name)).toEqual(
      ["urgent", "early-high", "low", "none-a", "none-b"].map(named),
    );
    expect(listing.waiting.map(({ name }) => name)).toEqual(["waits-word", "after-low"].map(named));
    expect(listing.tasks).toEqual([]);
  });
});

describe("stop", () => {
  test("takes a running task back to queued, keeping its fields and added time, and refuses a queued or unknown one", () => {
    const ctx = context();
    const { dir, task } = started(ctx, "task-a", "s1");
    wait(ctx, { name: "task-a", after: [], waits: "a review", until: null });
    expect(stop(later(ctx), "task-a")).toEqual({
      name: named("task-a"),
      state: "queued",
      repo: dir,
      ...UNQUEUED,
      waits: "a review",
      added: task.added,
      after: [],
      until: null,
    });
    expect(() => stop(ctx, "task-a")).toThrow(
      expect.objectContaining({
        code: "wrong_state",
        meta: {
          name: "task-a",
          act: "stop",
          state: "queued",
          admits: [
            "agent-task add task-a --repo <path> --goal <text> [--plan <file>] [--priority urgent|high|medium|low] [--after <name>]... [--waits <text>] [--until <command>]",
            "agent-task wait task-a [--after <name>]... [--waits <text>] [--until <command>]",
            "agent-task start task-a --repo <path> --brief <file> [--session <id>]",
            "agent-task done task-a",
          ],
        },
        resolve: expect.stringContaining("task-a is queued, which admits: agent-task add task-a"),
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
    expect(list(ctx)).toEqual(EMPTY);
    const again = added(ctx, "task-a", { after: [] });
    added(ctx, "task-b", { after: ["task-a"] });
    expect(done(ctx, "task-a")).toEqual(again.task);
    expect(taskByName(ctx.store, named("task-a"))).toBeNull();
    expect(list(ctx).ready.map(({ name, after }) => [name, after])).toEqual([[named("task-b"), []]]);
    expect(list(ctx).waiting).toEqual([]);
    add(ctx, request("task-a", again.dir));
    expect(list(ctx).waiting.map(({ name, after }) => [name, after])).toEqual([
      [named("task-b"), [named("task-a")]],
    ]);
  });

  test("refuses an invalid name for review, stop and done as it does for start", () => {
    const ctx = context();
    for (const act of [review, stop, done])
      expect(() => act(ctx, "Task_A")).toThrow(
        expect.objectContaining({ code: "invalid_name", meta: { name: "Task_A" } }),
      );
  });
});
