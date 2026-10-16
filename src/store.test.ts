import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { named, removeScratchDirs, scratchDir } from "./repo.test-support";
import {
  closeStore,
  heldAfter,
  insertQueued,
  insertRunning,
  openStore,
  queuedTasks,
  readStore,
  removeTask,
  replaceQueued,
  setWaiting,
  startedTasks,
  startQueued,
  stopTask,
  taskByName,
} from "./store";

afterAll(removeScratchDirs);

const WAIT = 0;

const FIELDS = { goal: null, plan: null, priority: null, waits: null };

const ADDED = { name: named("a"), repo: "/r", ...FIELDS, added: "2026-10-16T09:00:00.000Z" };

const QUEUED = { ...ADDED, after: [] };

const STARTED = {
  brief: "/r/brief.md",
  briefSha: "abc",
  session: "s1",
  started: "2026-10-16T10:00:00.000Z",
};

const RUNNING = { ...ADDED, ...STARTED };

function freshStore() {
  return openStore(join(scratchDir(), "nested", "tasks.db"), WAIT);
}

const VERSION_ONE = `
CREATE TABLE tasks (
  name TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  brief TEXT NOT NULL,
  brief_sha TEXT NOT NULL,
  started_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'dropped')),
  ended_at TEXT,
  reason TEXT
) STRICT;
CREATE TABLE task_commits (task TEXT NOT NULL REFERENCES tasks (name), sha TEXT NOT NULL, PRIMARY KEY (task, sha)) STRICT;
INSERT INTO tasks VALUES ('old-running', '/r', '/r/old.md', 'sha1', '2026-10-15T08:00:00.000Z', 'running', NULL, NULL);
INSERT INTO tasks VALUES ('old-done', '/r', '/r/done.md', 'sha2', '2026-10-15T07:00:00.000Z', 'done', '2026-10-15T09:00:00.000Z', NULL);
INSERT INTO tasks VALUES ('old-dropped', '/r', '/r/dropped.md', 'sha3', '2026-10-15T06:00:00.000Z', 'dropped', '2026-10-15T09:00:00.000Z', 'given up');
INSERT INTO task_commits VALUES ('old-done', 'c1');
PRAGMA user_version = 1;
`;

function versionOneStore(): string {
  const path = join(scratchDir(), "tasks.db");
  const db = new Database(path);
  db.run(VERSION_ONE);
  db.close();
  return path;
}

describe("the store", () => {
  test("creates its directory and schema on first open, and opens it again", () => {
    const path = join(scratchDir(), "nested", "tasks.db");
    closeStore(openStore(path, WAIT));
    const store = openStore(path, WAIT);
    expect(startedTasks(store)).toEqual([]);
    closeStore(store);
  });

  test("inserts a running or a queued task, returning it with the after names the store holds, and returns null for a name it holds", () => {
    const store = freshStore();
    expect(insertRunning(store, RUNNING)).toEqual({ ...RUNNING, state: "running" });
    expect(insertRunning(store, { ...RUNNING, repo: "/other" })).toBeNull();
    const full = {
      ...QUEUED,
      name: named("b"),
      goal: "ship it",
      plan: "/r/plan.md",
      priority: "high" as const,
      waits: "the owner",
      after: [named("a"), named("zed")],
    };
    const held = { ...full, after: [named("a")], state: "queued" as const };
    expect(insertQueued(store, full)).toEqual(held);
    expect(insertQueued(store, QUEUED)).toBeNull();
    expect(taskByName(store, named("a"))).toEqual({ ...RUNNING, state: "running" });
    expect(taskByName(store, named("b"))).toEqual(held);
    insertQueued(store, { ...QUEUED, name: named("zed") });
    expect(taskByName(store, named("b"))).toEqual({ ...full, state: "queued" });
    expect(taskByName(store, named("c"))).toBeNull();
  });

  test("replaces only a queued task's fields and after names, keeping its added time", () => {
    const store = freshStore();
    insertQueued(store, { ...QUEUED, name: named("b"), after: [named("a")] });
    insertRunning(store, RUNNING);
    insertQueued(store, { ...QUEUED, name: named("c") });
    const replaced = {
      name: named("b"),
      repo: "/other",
      goal: "again",
      plan: null,
      priority: "low" as const,
      waits: null,
      after: [named("c")],
    };
    expect(replaceQueued(store, replaced)).toEqual({ ...replaced, added: QUEUED.added, state: "queued" });
    expect(taskByName(store, named("b"))).toMatchObject({ after: [named("c")] });
    expect(replaceQueued(store, { ...replaced, name: named("a") })).toBeNull();
    expect(replaceQueued(store, { ...replaced, name: named("missing") })).toBeNull();
    expect(taskByName(store, named("a"))).toEqual({ ...RUNNING, state: "running" });
  });

  test("starts only a queued task, keeping its fields, taking the repo and dropping its after names, and shows only the after names the store holds", () => {
    const store = freshStore();
    const queued = {
      ...QUEUED,
      goal: "g",
      priority: "urgent" as const,
      waits: "w",
      after: [named("b"), named("gone")],
    };
    expect(insertQueued(store, queued)).toMatchObject({ after: [] });
    insertQueued(store, { ...QUEUED, name: named("b") });
    expect(heldAfter(store, named("a"))).toEqual([named("b")]);
    expect(taskByName(store, named("a"))).toMatchObject({ after: [named("b")] });
    removeTask(store, named("b"));
    expect(heldAfter(store, named("a"))).toEqual([]);
    const start = { name: named("a"), repo: "/moved", ...STARTED };
    const { after, ...fields } = queued;
    expect(after).toHaveLength(2);
    expect(startQueued(store, start)).toEqual({ ...fields, ...start, state: "running" });
    expect(startQueued(store, start)).toBeNull();
    expect(startQueued(store, { ...start, name: named("missing") })).toBeNull();
    expect(stopTask(store, named("a"))).toEqual({ ...queued, repo: "/moved", after: [], state: "queued" });
  });

  test("sets what a task waits for: the text in any state, the after names on a queued task only, and refuses after names on a running task", () => {
    const store = freshStore();
    insertQueued(store, { ...QUEUED, after: [named("x")] });
    insertRunning(store, { ...RUNNING, name: named("r") });
    insertQueued(store, { ...QUEUED, name: named("y") });
    expect(setWaiting(store, named("a"), { after: [named("y")], waits: "owner" })).toEqual({
      ...QUEUED,
      after: [named("y")],
      waits: "owner",
      state: "queued",
    });
    expect(setWaiting(store, named("a"), { after: [], waits: null })).toEqual({ ...QUEUED, state: "queued" });
    expect(setWaiting(store, named("r"), { after: [], waits: "ci" })).toEqual({
      ...RUNNING,
      name: named("r"),
      waits: "ci",
      state: "running",
    });
    expect(setWaiting(store, named("r"), { after: [named("a")], waits: null })).toBeNull();
    expect(taskByName(store, named("r"))).toMatchObject({ waits: "ci" });
    expect(setWaiting(store, named("missing"), { after: [], waits: null })).toBeNull();
  });

  test("stops only a running task back to queued, keeping its added time, and removes a task in any state", () => {
    const store = freshStore();
    insertRunning(store, RUNNING);
    insertQueued(store, { ...QUEUED, name: named("b") });
    expect(stopTask(store, named("a"))).toEqual({ ...QUEUED, state: "queued" });
    expect(stopTask(store, named("a"))).toBeNull();
    expect(stopTask(store, named("missing"))).toBeNull();
    expect(removeTask(store, named("a"))).toEqual({ ...QUEUED, state: "queued" });
    expect(removeTask(store, named("a"))).toBeNull();
    insertQueued(store, { ...QUEUED, name: named("c"), after: [named("b")] });
    expect(removeTask(store, named("c"))).toMatchObject({ after: [named("b")] });
    expect(store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM task_after").get()?.n).toBe(0);
    expect(taskByName(store, named("a"))).toBeNull();
    expect(insertRunning(store, RUNNING)).toMatchObject({ state: "running" });
    expect(removeTask(store, named("a"))).toEqual({ ...RUNNING, state: "running" });
    expect(removeTask(store, named("b"))).toMatchObject({ state: "queued" });
    expect(startedTasks(store)).toEqual([]);
  });

  test("lists started tasks oldest first and by name within one time, and queued tasks by priority, added time and name with their after names", () => {
    const store = freshStore();
    insertRunning(store, { ...RUNNING, name: named("alpha"), started: "2026-10-16T12:00:00.000Z" });
    insertRunning(store, { ...RUNNING, name: named("tie-b"), started: "2026-10-16T11:00:00.000Z" });
    insertRunning(store, { ...RUNNING, name: named("tie-a"), started: "2026-10-16T11:00:00.000Z" });
    insertRunning(store, { ...RUNNING, name: named("zeta") });
    insertQueued(store, { ...QUEUED, name: named("later"), added: "2026-10-16T13:00:00.000Z" });
    insertQueued(store, { ...QUEUED, name: named("sooner"), after: [named("zeta"), named("alpha")] });
    insertQueued(store, {
      ...QUEUED,
      name: named("low"),
      priority: "low",
      added: "2026-10-16T14:00:00.000Z",
    });
    insertQueued(store, {
      ...QUEUED,
      name: named("urgent"),
      priority: "urgent",
      added: "2026-10-16T15:00:00.000Z",
    });
    insertQueued(store, { ...QUEUED, name: named("high-b"), priority: "high" });
    insertQueued(store, { ...QUEUED, name: named("high-a"), priority: "high" });
    expect(startedTasks(store).map(({ name }) => name)).toEqual([
      named("zeta"),
      named("tie-a"),
      named("tie-b"),
      named("alpha"),
    ]);
    expect(queuedTasks(store).map(({ name, after }) => [name, after])).toEqual([
      [named("urgent"), []],
      [named("high-a"), []],
      [named("high-b"), []],
      [named("low"), []],
      [named("sooner"), [named("alpha"), named("zeta")]],
      [named("later"), []],
    ]);
  });

  test("refuses a row that breaks a state's rule, so the database holds them", () => {
    const store = freshStore();
    insertRunning(store, RUNNING);
    expect(() => store.db.run("UPDATE tasks SET state = 'queued' WHERE name = 'a'")).toThrow();
    expect(() => store.db.run("UPDATE tasks SET brief = NULL WHERE name = 'a'")).toThrow();
    expect(() => store.db.run("UPDATE tasks SET started_at = NULL WHERE name = 'a'")).toThrow();
    expect(() => store.db.run("UPDATE tasks SET state = 'done' WHERE name = 'a'")).toThrow();
    expect(() => store.db.run("UPDATE tasks SET priority = 'top' WHERE name = 'a'")).toThrow();
    expect(() => store.db.run("INSERT INTO task_after VALUES ('nobody', 'a')")).toThrow();
    expect(() =>
      store.db.run(
        "UPDATE tasks SET state = 'queued', brief = NULL, brief_sha = NULL, started_at = NULL WHERE name = 'a'",
      ),
    ).toThrow();
  });

  test("migrates a version-1 store, keeping its running tasks with their start time as the added time and no session, goal, plan, priority or waits, and removing the ended ones", () => {
    const path = versionOneStore();
    const store = openStore(path, WAIT);
    expect(startedTasks(store)).toEqual([
      {
        name: named("old-running"),
        state: "running",
        repo: "/r",
        ...FIELDS,
        added: "2026-10-15T08:00:00.000Z",
        brief: "/r/old.md",
        briefSha: "sha1",
        session: null,
        started: "2026-10-15T08:00:00.000Z",
      },
    ]);
    expect(taskByName(store, named("old-done"))).toBeNull();
    expect(taskByName(store, named("old-dropped"))).toBeNull();
    expect(
      store.db
        .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'task_commits'")
        .get()?.n,
    ).toBe(0);
    expect(store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
    closeStore(store);
    expect(insertRunning(openStore(path, WAIT), { ...RUNNING, name: named("old-done") })).toMatchObject({
      state: "running",
    });
  });

  test("reads a version-1 store as migratable without changing it, and a current or absent one as itself", () => {
    const path = versionOneStore();
    const bytes = readFileSync(path);
    expect(readStore(path, WAIT)).toEqual({ kind: "migratable", found: 1 });
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(readStore(join(scratchDir(), "none.db"), WAIT)).toEqual({ kind: "none" });
    const current = freshStore();
    closeStore(current);
    const read = readStore(current.path, WAIT);
    expect(read.kind).toBe("open");
    if (read.kind === "open") closeStore(read.store);
  });

  test("refuses a store of another version and a file that is no store, leaving each as it was", () => {
    const newer = join(scratchDir(), "tasks.db");
    const db = new Database(newer);
    db.run("PRAGMA user_version = 3");
    db.close();
    const bytes = readFileSync(newer);
    expect(() => openStore(newer, WAIT)).toThrow(
      expect.objectContaining({ code: "store_version", meta: { path: newer, found: 3, expected: 2 } }),
    );
    expect(() => readStore(newer, WAIT)).toThrow(expect.objectContaining({ code: "store_version" }));
    expect(readFileSync(newer).equals(bytes)).toBe(true);
    const junk = join(scratchDir(), "tasks.db");
    writeFileSync(
      junk,
      "not a database, but long enough to have a header of sorts...........................",
    );
    expect(() => openStore(junk, WAIT)).toThrow(expect.objectContaining({ code: "store_unopenable" }));
  });

  test("refuses as busy while another connection holds the write lock past the wait", () => {
    const path = join(scratchDir(), "tasks.db");
    const store = openStore(path, WAIT);
    const holder = new Database(path);
    holder.run("BEGIN IMMEDIATE");
    expect(() => openStore(path, WAIT)).toThrow(
      expect.objectContaining({ code: "store_busy", kind: "refusal", meta: { path, waitedMs: 0 } }),
    );
    expect(() => insertRunning(store, RUNNING)).toThrow(expect.objectContaining({ code: "store_busy" }));
    holder.run("ROLLBACK");
    expect(insertRunning(store, RUNNING)).toMatchObject({ name: named("a") });
  });
});
