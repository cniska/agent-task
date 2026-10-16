import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { named, removeScratchDirs, scratchDir } from "./repo.test-support";
import { closeStore, dropTask, finishTask, insertTask, openStore, runningTasks, taskByName } from "./store";

afterAll(removeScratchDirs);

const WAIT = 0;

const TASK = {
  name: named("a"),
  repo: "/r",
  brief: "/r/brief.md",
  briefSha: "abc",
  started: "2026-10-16T10:00:00.000Z",
};

function freshStore() {
  return openStore(join(scratchDir(), "nested", "tasks.db"), WAIT);
}

describe("the store", () => {
  test("creates its directory and schema on first open, and opens it again", () => {
    const path = join(scratchDir(), "nested", "tasks.db");
    closeStore(openStore(path, WAIT));
    const store = openStore(path, WAIT);
    expect(runningTasks(store)).toEqual([]);
    closeStore(store);
  });

  test("inserts a running task, returning it, and returns null for a name it holds", () => {
    const store = freshStore();
    expect(insertTask(store, TASK)).toEqual({ ...TASK, state: "running" });
    expect(insertTask(store, { ...TASK, repo: "/other" })).toBeNull();
    expect(taskByName(store, named("a"))).toEqual({ ...TASK, state: "running" });
    expect(taskByName(store, named("b"))).toBeNull();
  });

  test("ends only a running task, returning it, and null once it has ended", () => {
    const store = freshStore();
    insertTask(store, TASK);
    insertTask(store, { ...TASK, name: named("b") });
    const ended = "2026-10-16T11:00:00.000Z";
    expect(finishTask(store, named("a"), ended, ["c1", "c2"])).toEqual({
      ...TASK,
      state: "done",
      ended,
      commits: ["c1", "c2"],
    });
    expect(dropTask(store, named("b"), ended, "died")).toEqual({
      ...TASK,
      name: named("b"),
      state: "dropped",
      ended,
      reason: "died",
    });
    expect(finishTask(store, named("a"), ended, ["c3"])).toBeNull();
    expect(dropTask(store, named("a"), ended, "x")).toBeNull();
    expect(finishTask(store, named("b"), ended, ["c3"])).toBeNull();
    expect(dropTask(store, named("missing"), ended, "x")).toBeNull();
    expect(taskByName(store, named("a"))).toMatchObject({ state: "done", commits: ["c1", "c2"] });
  });

  test("lists only running tasks, oldest first and by name within one time", () => {
    const store = freshStore();
    insertTask(store, { ...TASK, name: named("alpha"), started: "2026-10-16T12:00:00.000Z" });
    insertTask(store, { ...TASK, name: named("tie-b"), started: "2026-10-16T11:00:00.000Z" });
    insertTask(store, { ...TASK, name: named("tie-a"), started: "2026-10-16T11:00:00.000Z" });
    insertTask(store, { ...TASK, name: named("zeta") });
    insertTask(store, { ...TASK, name: named("gone") });
    dropTask(store, named("gone"), "2026-10-16T13:00:00.000Z", "x");
    expect(runningTasks(store).map(({ name }) => name)).toEqual([
      named("zeta"),
      named("tie-a"),
      named("tie-b"),
      named("alpha"),
    ]);
  });

  test("refuses a row that breaks a state's rule, so the database holds them", () => {
    const store = freshStore();
    insertTask(store, TASK);
    expect(() => store.db.run("UPDATE tasks SET state = 'done' WHERE name = 'a'")).toThrow();
    expect(() =>
      store.db.run("UPDATE tasks SET state = 'dropped', ended_at = 'x' WHERE name = 'a'"),
    ).toThrow();
    expect(() => store.db.run("UPDATE tasks SET state = 'lost', ended_at = 'x' WHERE name = 'a'")).toThrow();
    expect(() => store.db.run("INSERT INTO task_commits (task, sha) VALUES ('nobody', 'c')")).toThrow();
  });

  test("refuses a store of another version and a file that is no store, leaving each as it was", () => {
    const newer = join(scratchDir(), "tasks.db");
    const db = new Database(newer);
    db.run("PRAGMA user_version = 2");
    db.close();
    const bytes = readFileSync(newer);
    expect(() => openStore(newer, WAIT)).toThrow(
      expect.objectContaining({ code: "store_version", meta: { path: newer, found: 2, expected: 1 } }),
    );
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
    expect(() => insertTask(store, TASK)).toThrow(expect.objectContaining({ code: "store_busy" }));
    holder.run("ROLLBACK");
    expect(insertTask(store, TASK)).toMatchObject({ name: named("a") });
  });
});
