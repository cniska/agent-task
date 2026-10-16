import { Database, SQLiteError } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { invariant } from "./assert";
import { BUG, faults, refusals } from "./coded-error";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE tasks (
  name TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  brief TEXT NOT NULL,
  brief_sha TEXT NOT NULL,
  started_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'dropped')),
  ended_at TEXT,
  reason TEXT,
  CHECK ((state = 'running') = (ended_at IS NULL)),
  CHECK ((state = 'dropped') = (reason IS NOT NULL))
) STRICT;
CREATE TABLE task_commits (
  task TEXT NOT NULL REFERENCES tasks (name),
  sha TEXT NOT NULL,
  PRIMARY KEY (task, sha)
) STRICT;
PRAGMA user_version = ${SCHEMA_VERSION};
`;

const TASK_COLUMNS = "name, repo, brief, brief_sha, started_at, state, ended_at, reason";

const BUSY = "SQLITE_BUSY";

const WAL_RETRY_MS = 5;

const UNOPENABLE = ["SQLITE_CANTOPEN", "SQLITE_NOTADB"];

const refuse = refusals<{
  readonly store_busy: { readonly path: string; readonly waitedMs: number };
  readonly store_unopenable: { readonly path: string; readonly detail: string };
  readonly store_version: { readonly path: string; readonly found: number; readonly expected: number };
}>({
  store_busy: {
    message: ({ path, waitedMs }) => `${path} stayed locked by another agent-task for ${waitedMs} ms`,
    resolve: () => "run the command again once the other agent-task command has finished",
  },
  store_unopenable: {
    message: ({ path, detail }) => `${path} cannot be opened as the task store: ${detail}`,
    resolve: ({ path }) => `stop and hand this error to the owner: ${path} must be an agent-task store`,
  },
  store_version: {
    message: ({ path, found, expected }) =>
      `${path} holds store version ${found}, and this agent-task reads version ${expected}`,
    resolve: () => "stop and hand this error to the owner: run the agent-task that wrote this store",
  },
});

const fault = faults<{ readonly row_malformed: { readonly detail: string } }>({
  row_malformed: { message: ({ detail }) => `a stored task is malformed: ${detail}`, resolve: () => BUG },
});

export type TaskName = string & { readonly __brand: "TaskName" };

const TASK_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isTaskName(name: string): name is TaskName {
  return TASK_NAME.test(name);
}

function taskName(row: Record<string, unknown>): TaskName {
  const name = text(row, "name");
  if (!isTaskName(name)) throw fault("row_malformed", { detail: `${JSON.stringify(name)} is no task name` });
  return name;
}

type Started = {
  readonly name: TaskName;
  readonly repo: string;
  readonly brief: string;
  readonly briefSha: string;
  readonly started: string;
};

export type Running = Started & { readonly state: "running" };

export type Dropped = Started & {
  readonly state: "dropped";
  readonly ended: string;
  readonly reason: string;
};

export type Commits = readonly [string, ...string[]];

export type Done = Started & { readonly state: "done"; readonly ended: string; readonly commits: Commits };

export type Task = Running | Done | Dropped;

export type Store = { readonly db: Database; readonly path: string; readonly busyWaitMs: number };

function sqliteCode(error: unknown): string | null {
  return error instanceof SQLiteError && typeof error.code === "string" ? error.code : null;
}

function translated<T>({ path, busyWaitMs }: Omit<Store, "db">, act: () => T): T {
  try {
    return act();
  } catch (error) {
    if (sqliteCode(error)?.startsWith(BUSY)) throw refuse("store_busy", { path, waitedMs: busyWaitMs });
    throw error;
  }
}

function userVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  invariant(row !== null, "PRAGMA user_version returns one row");
  return row.user_version;
}

function holdsNoTables(db: Database): boolean {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master").get()?.n === 0;
}

function connect(path: string, busyWaitMs: number): Database {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const db = new Database(path, { create: true, strict: true });
    db.run(`PRAGMA busy_timeout = ${busyWaitMs}`);
    userVersion(db);
    return db;
  } catch (error) {
    const code = sqliteCode(error);
    if (code !== null && UNOPENABLE.some((unopenable) => code.startsWith(unopenable)))
      throw refuse("store_unopenable", { path, detail: String(error) });
    throw error;
  }
}

function refuseOtherVersion(db: Database, path: string): void {
  const found = userVersion(db);
  if (found === SCHEMA_VERSION || (found === 0 && holdsNoTables(db))) return;
  throw refuse("store_version", { path, found, expected: SCHEMA_VERSION });
}

function enableWal(db: Database, busyWaitMs: number): void {
  const deadline = Date.now() + busyWaitMs;
  for (;;) {
    try {
      db.run("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!sqliteCode(error)?.startsWith(BUSY) || Date.now() >= deadline) throw error;
      Bun.sleepSync(WAL_RETRY_MS);
    }
  }
}

export function openStore(path: string, busyWaitMs: number): Store {
  const db = connect(path, busyWaitMs);
  try {
    translated({ path, busyWaitMs }, () => db.transaction(() => refuseOtherVersion(db, path)).deferred());
    translated({ path, busyWaitMs }, () => {
      enableWal(db, busyWaitMs);
      db.run("PRAGMA foreign_keys = ON");
      db.transaction(() => {
        if (userVersion(db) === 0 && holdsNoTables(db)) db.run(SCHEMA);
      }).immediate();
    });
    refuseOtherVersion(db, path);
    return { db, path, busyWaitMs };
  } catch (error) {
    db.close();
    throw error;
  }
}

function text(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw fault("row_malformed", { detail: `${column} is not text` });
  return value;
}

function nullableText(row: Record<string, unknown>, column: string): string | null {
  return row[column] === null ? null : text(row, column);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rowRecord(row: unknown): Record<string, unknown> {
  if (!isRecord(row)) throw fault("row_malformed", { detail: "the row is not a record" });
  return row;
}

function commitsOf(db: Database, name: TaskName): Commits {
  const shas = db
    .query<unknown, [string]>("SELECT sha FROM task_commits WHERE task = ? ORDER BY rowid")
    .all(name)
    .map((row) => text(rowRecord(row), "sha"));
  const [first, ...rest] = shas;
  if (first === undefined) throw fault("row_malformed", { detail: `done task ${name} has no commits` });
  return [first, ...rest];
}

function parseTask(db: Database, value: unknown): Task {
  const row = rowRecord(value);
  const started: Started = {
    name: taskName(row),
    repo: text(row, "repo"),
    brief: text(row, "brief"),
    briefSha: text(row, "brief_sha"),
    started: text(row, "started_at"),
  };
  const state = text(row, "state");
  const ended = nullableText(row, "ended_at");
  const reason = nullableText(row, "reason");
  if (state === "running" && ended === null) return { ...started, state };
  if (state === "dropped" && ended !== null && reason !== null) return { ...started, state, ended, reason };
  if (state === "done" && ended !== null && reason === null)
    return { ...started, state, ended, commits: commitsOf(db, started.name) };
  throw fault("row_malformed", { detail: `state ${state} does not fit its ended_at and reason` });
}

export type NewTask = Omit<Running, "state">;

export function insertTask(store: Store, task: NewTask): Running | null {
  const { db } = store;
  const row = translated(store, () =>
    db
      .query<unknown, [string, string, string, string, string]>(
        `INSERT INTO tasks (name, repo, brief, brief_sha, started_at, state)
         VALUES (?, ?, ?, ?, ?, 'running') ON CONFLICT (name) DO NOTHING RETURNING ${TASK_COLUMNS}`,
      )
      .get(task.name, task.repo, task.brief, task.briefSha, task.started),
  );
  if (row === null) return null;
  const inserted = parseTask(db, row);
  invariant(inserted.state === "running", "an inserted task is running");
  return inserted;
}

export function dropTask(store: Store, name: TaskName, ended: string, reason: string): Dropped | null {
  const { db } = store;
  const row = translated(store, () =>
    db
      .query<unknown, [string, string, string]>(
        `UPDATE tasks SET state = 'dropped', ended_at = ?, reason = ?
         WHERE name = ? AND state = 'running' RETURNING ${TASK_COLUMNS}`,
      )
      .get(ended, reason, name),
  );
  if (row === null) return null;
  const dropped = parseTask(db, row);
  invariant(dropped.state === "dropped", "a dropped task is dropped");
  return dropped;
}

export function finishTask(store: Store, name: TaskName, ended: string, commits: Commits): Done | null {
  const { db } = store;
  const row = translated(store, () =>
    db
      .transaction(() => {
        const updated = db
          .query<unknown, [string, string]>(
            `UPDATE tasks SET state = 'done', ended_at = ?
             WHERE name = ? AND state = 'running' RETURNING ${TASK_COLUMNS}`,
          )
          .get(ended, name);
        if (updated === null) return null;
        const insert = db.query<unknown, [string, string]>(
          "INSERT INTO task_commits (task, sha) VALUES (?, ?)",
        );
        for (const sha of commits) insert.run(name, sha);
        return updated;
      })
      .immediate(),
  );
  if (row === null) return null;
  const done = parseTask(db, row);
  invariant(done.state === "done", "a finished task is done");
  return done;
}

export function taskByName(store: Store, name: TaskName): Task | null {
  const { db } = store;
  const row = translated(store, () =>
    db.query<unknown, [string]>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE name = ?`).get(name),
  );
  return row === null ? null : parseTask(db, row);
}

export function runningTasks(store: Store): readonly Running[] {
  const { db } = store;
  const rows = translated(store, () =>
    db
      .query<unknown, []>(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE state = 'running' ORDER BY started_at, name`,
      )
      .all(),
  );
  return rows.map((row) => {
    const task = parseTask(db, row);
    invariant(task.state === "running", "a task listed as running is running");
    return task;
  });
}

export function closeStore({ db }: Store): void {
  db.close();
}
