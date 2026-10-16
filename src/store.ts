import { Database, SQLiteError } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { invariant, unreachable } from "./assert";
import { BUG, faults, refusals } from "./coded-error";

export const SCHEMA_VERSION = 2;

const TABLES = `
CREATE TABLE tasks (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running')),
  repo TEXT NOT NULL,
  added_at TEXT NOT NULL,
  brief TEXT,
  brief_sha TEXT,
  session TEXT,
  started_at TEXT,
  CHECK ((state = 'queued') = (brief IS NULL)),
  CHECK ((brief IS NULL) = (brief_sha IS NULL)),
  CHECK ((brief IS NULL) = (started_at IS NULL)),
  CHECK (brief IS NOT NULL OR session IS NULL)
) STRICT;
`;

const VERSION_PRAGMA = `PRAGMA user_version = ${SCHEMA_VERSION};`;

const SCHEMA = `${TABLES}${VERSION_PRAGMA}`;

const MIGRATE_FROM_VERSION_ONE = `
ALTER TABLE tasks RENAME TO tasks_v1;
DROP TABLE task_commits;
${TABLES}
INSERT INTO tasks (name, state, repo, added_at, brief, brief_sha, started_at)
  SELECT name, 'running', repo, started_at, brief, brief_sha, started_at FROM tasks_v1 WHERE state = 'running';
DROP TABLE tasks_v1;
${VERSION_PRAGMA}
`;

const MIGRATABLE_VERSION = 1;

const TASK_COLUMNS = "name, state, repo, added_at, brief, brief_sha, session, started_at";

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

type Added = {
  readonly name: TaskName;
  readonly repo: string;
  readonly added: string;
};

export type Queued = Added & { readonly state: "queued" };

type Started = Added & {
  readonly brief: string;
  readonly briefSha: string;
  readonly session: string | null;
  readonly started: string;
};

export type Running = Started & { readonly state: "running" };

export type Task = Queued | Running;

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

type Opening = "create" | "existing";

function connect(path: string, busyWaitMs: number, opening: Opening): Database {
  if (opening === "create") mkdirSync(dirname(path), { recursive: true });
  try {
    const db = new Database(path, { readwrite: true, create: opening === "create", strict: true });
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

type Found = "current" | "empty" | "migratable";

function versionFound(db: Database, path: string): Found {
  const found = userVersion(db);
  if (found === SCHEMA_VERSION) return "current";
  if (found === 0 && holdsNoTables(db)) return "empty";
  if (found === MIGRATABLE_VERSION) return "migratable";
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

function bringCurrent(db: Database, path: string): void {
  const found = versionFound(db, path);
  switch (found) {
    case "current":
      return;
    case "empty":
      db.run(SCHEMA);
      return;
    case "migratable":
      db.run(MIGRATE_FROM_VERSION_ONE);
      return;
    default:
      unreachable(found);
  }
}

export function openStore(path: string, busyWaitMs: number): Store {
  const db = connect(path, busyWaitMs, "create");
  try {
    translated({ path, busyWaitMs }, () => db.transaction(() => versionFound(db, path)).deferred());
    translated({ path, busyWaitMs }, () => {
      enableWal(db, busyWaitMs);
      db.run("PRAGMA foreign_keys = ON");
      db.transaction(() => bringCurrent(db, path)).immediate();
    });
    invariant(versionFound(db, path) === "current", "an opened store is at this version");
    return { db, path, busyWaitMs };
  } catch (error) {
    db.close();
    throw error;
  }
}

export type Read =
  | { readonly kind: "none" }
  | { readonly kind: "migratable"; readonly found: number }
  | { readonly kind: "open"; readonly store: Store };

export function readStore(path: string, busyWaitMs: number): Read {
  if (!existsSync(path)) return { kind: "none" };
  const db = connect(path, busyWaitMs, "existing");
  try {
    const found = translated({ path, busyWaitMs }, () =>
      db.transaction(() => versionFound(db, path)).deferred(),
    );
    if (found === "current") return { kind: "open", store: { db, path, busyWaitMs } };
    db.close();
    return found === "migratable" ? { kind: "migratable", found: MIGRATABLE_VERSION } : { kind: "none" };
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

function parseTask(value: unknown): Task {
  const row = rowRecord(value);
  const added: Added = { name: taskName(row), repo: text(row, "repo"), added: text(row, "added_at") };
  const state = text(row, "state");
  const brief = nullableText(row, "brief");
  const briefSha = nullableText(row, "brief_sha");
  const started = nullableText(row, "started_at");
  if (state === "queued" && brief === null) return { ...added, state };
  if (state === "running" && brief !== null && briefSha !== null && started !== null)
    return { ...added, state, brief, briefSha, session: nullableText(row, "session"), started };
  throw fault("row_malformed", { detail: `state ${state} does not fit its brief and times` });
}

function parseQueued(value: unknown): Queued {
  const task = parseTask(value);
  invariant(task.state === "queued", "a queued row is queued");
  return task;
}

function parseRunning(value: unknown): Running {
  const task = parseTask(value);
  invariant(task.state === "running", "a running row is running");
  return task;
}

export type NewQueued = Omit<Queued, "state">;

export function insertQueued(store: Store, task: NewQueued): Queued | null {
  const { db } = store;
  const row = translated(store, () =>
    db
      .query<unknown, [string, string, string]>(
        `INSERT INTO tasks (name, state, repo, added_at) VALUES (?, 'queued', ?, ?)
         ON CONFLICT (name) DO NOTHING RETURNING ${TASK_COLUMNS}`,
      )
      .get(task.name, task.repo, task.added),
  );
  return row === null ? null : parseQueued(row);
}

export type NewRunning = Omit<Running, "state">;

export function insertRunning(store: Store, task: NewRunning): Running | null {
  const { db } = store;
  const row = translated(store, () =>
    db
      .query<unknown, [string, string, string, string, string, string | null, string]>(
        `INSERT INTO tasks (name, state, repo, added_at, brief, brief_sha, session, started_at)
         VALUES (?, 'running', ?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING RETURNING ${TASK_COLUMNS}`,
      )
      .get(task.name, task.repo, task.added, task.brief, task.briefSha, task.session, task.started),
  );
  return row === null ? null : parseRunning(row);
}

export function startQueued(store: Store, task: Omit<NewRunning, "added">): Running | null {
  const { db } = store;
  const row = translated(store, () =>
    db
      .query<unknown, [string, string, string, string | null, string, string]>(
        `UPDATE tasks SET state = 'running', repo = ?, brief = ?, brief_sha = ?, session = ?, started_at = ?
         WHERE name = ? AND state = 'queued' RETURNING ${TASK_COLUMNS}`,
      )
      .get(task.repo, task.brief, task.briefSha, task.session, task.started, task.name),
  );
  return row === null ? null : parseRunning(row);
}

export function stopTask(store: Store, name: TaskName): Queued | null {
  const { db } = store;
  const row = translated(store, () =>
    db
      .query<unknown, [string]>(
        `UPDATE tasks SET state = 'queued', brief = NULL, brief_sha = NULL, session = NULL, started_at = NULL
         WHERE name = ? AND state = 'running' RETURNING ${TASK_COLUMNS}`,
      )
      .get(name),
  );
  return row === null ? null : parseQueued(row);
}

export function removeTask(store: Store, name: TaskName): Task | null {
  const { db } = store;
  const row = translated(store, () =>
    db.query<unknown, [string]>(`DELETE FROM tasks WHERE name = ? RETURNING ${TASK_COLUMNS}`).get(name),
  );
  return row === null ? null : parseTask(row);
}

export function taskByName(store: Store, name: TaskName): Task | null {
  const { db } = store;
  const row = translated(store, () =>
    db.query<unknown, [string]>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE name = ?`).get(name),
  );
  return row === null ? null : parseTask(row);
}

export function startedTasks(store: Store): readonly Running[] {
  const { db } = store;
  const rows = translated(store, () =>
    db
      .query<unknown, []>(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE state = 'running' ORDER BY started_at, name`,
      )
      .all(),
  );
  return rows.map(parseRunning);
}

export function queuedTasks(store: Store): readonly Queued[] {
  const { db } = store;
  const rows = translated(store, () =>
    db
      .query<unknown, []>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE state = 'queued' ORDER BY added_at, name`)
      .all(),
  );
  return rows.map(parseQueued);
}

export function closeStore({ db }: Store): void {
  db.close();
}
