import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  binWith,
  brief,
  git,
  listing,
  type Ran,
  refusal,
  removeScratch,
  repo,
  result,
  run,
  runAtOnce,
  type Shown,
  type World,
  world,
} from "./harness";

afterEach(removeScratch);

const BRIEF_SHA = "b0ac2230fd4c9051b89302545e75ece9b569e35f";

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
PRAGMA user_version = 1;
`;

function listed(w: World): readonly Shown[] {
  return listing(run(w, w.root, ["list"])).tasks;
}

function ready(w: World): readonly Shown[] {
  return listing(run(w, w.root, ["list"])).ready;
}

function waiting(w: World): readonly Shown[] {
  return listing(run(w, w.root, ["list"])).waiting;
}

function names(tasks: readonly Shown[]): readonly unknown[] {
  return tasks.map(({ name }) => name);
}

function add(w: World, name: string, at: string, goal: string, ...flags: string[]): Ran {
  return run(w, w.root, ["add", name, "--repo", at, "--goal", goal, ...flags]);
}

const UNQUEUED = { goal: null, plan: null, priority: null, waits: null };

function start(w: World, name: string, at: string, briefPath: string, cwd = w.root): Ran {
  return run(w, cwd, ["start", name, "--repo", at, "--brief", briefPath]);
}

function storeOfVersion(w: World, version: number, schema = ""): string {
  const dir = join(w.root, "data", "agent-task");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "tasks.db");
  const db = new Database(path);
  db.run(`${schema}\nPRAGMA user_version = ${version};`);
  db.close();
  return path;
}

test("AC-1 start records the task in the store under XDG_DATA_HOME, with its session when given, and list prints it unchanged", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(w.root);
  const before = Date.now();
  const started = result(start(w, "task-a", dir, file));
  expect(started).toMatchObject({
    name: "task-a",
    state: "running",
    repo: dir,
    brief: file,
    briefSha: BRIEF_SHA,
    session: null,
    ...UNQUEUED,
  });
  expect(started.added).toBe(started.started);
  expect(Date.parse(String(started.started))).toBeGreaterThanOrEqual(before - 1000);
  expect(existsSync(join(w.root, "data", "agent-task", "tasks.db"))).toBe(true);
  const withSession = result(
    run(w, w.root, ["start", "task-b", "--repo", dir, "--brief", file, "--session", "session-1"]),
  );
  expect(withSession).toMatchObject({ name: "task-b", session: "session-1" });
  expect(listing(run(w, w.root, ["list"]))).toEqual({
    tasks: [
      { ...started, briefChanged: false },
      { ...withSession, briefChanged: false },
    ],
    ready: [],
    waiting: [],
  });
});

test("AC-2 an unset, empty or relative XDG_DATA_HOME puts the store under HOME/.local/share", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(w.root);
  const store = join(w.root, "home", ".local", "share", "agent-task", "tasks.db");
  const cases = [
    { unset: ["XDG_DATA_HOME"] },
    { env: { XDG_DATA_HOME: "" } },
    { env: { XDG_DATA_HOME: "data" } },
  ];
  for (const [index, options] of cases.entries()) {
    rmSync(join(w.root, "home", ".local"), { recursive: true, force: true });
    const name = `task-${index}`;
    expect(run(w, w.root, ["start", name, "--repo", dir, "--brief", file], options).exitCode).toBe(0);
    expect(existsSync(store)).toBe(true);
    expect(existsSync(join(w.root, "data", "agent-task"))).toBe(false);
  }
});

test("AC-3 start from inside the repository and from a linked worktree records the main working tree, and done removes the task after the worktree is gone", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(w.root);
  const inside = join(dir, "inside");
  mkdirSync(inside);
  expect(result(start(w, "from-inside", "inside", file, dir))).toMatchObject({ repo: dir });
  const linked = join(w.root, "linked");
  git(w, dir, ["worktree", "add", "-q", "-b", "topic", linked]);
  const fromLinked = result(start(w, "from-linked", linked, file));
  expect(fromLinked).toMatchObject({ repo: dir });
  git(w, dir, ["worktree", "remove", linked]);
  expect(result(run(w, w.root, ["done", "from-linked"]))).toEqual(fromLinked);
  expect(listed(w).map(({ name }) => name)).toEqual(["from-inside"]);
});

test("AC-4 start on a path outside git, a bare repository and a submodule is refused not_a_checkout", () => {
  const w = world();
  const file = brief(w.root);
  const outside = join(w.root, "outside");
  mkdirSync(outside);
  const bare = join(w.root, "bare.git");
  git(w, w.root, ["init", "-q", "--bare", bare]);
  const sub = repo(w, "sub");
  const superproject = repo(w, "superproject");
  git(w, superproject, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod"]);
  for (const path of [outside, bare, join(superproject, "mod")]) {
    expect(refusal(start(w, "task-a", path, file))).toMatchObject({ code: "not_a_checkout", meta: { path } });
  }
  expect(listed(w)).toEqual([]);
});

test("AC-5 start refuses an invalid name and an unreadable brief, recording nothing", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(w.root);
  for (const name of ["Task", "task_a", "task-", "task--a", "task a", "tâsk"]) {
    expect(refusal(start(w, name, dir, file))).toMatchObject({ code: "invalid_name", meta: { name } });
  }
  const unreadable = brief(w.root, "unreadable.md");
  chmodSync(unreadable, 0o000);
  for (const missing of [join(w.root, "missing.md"), unreadable, w.root]) {
    expect(refusal(start(w, "task-a", dir, missing))).toMatchObject({
      code: "brief_unreadable",
      meta: { brief: missing },
    });
  }
  expect(listed(w)).toEqual([]);
});

test("AC-6 start refuses a running name, naming what it admits, starts a stopped one again keeping its added time, and starts a removed name afresh", () => {
  const w = world();
  const dir = repo(w);
  const other = repo(w, "other");
  const file = brief(w.root);
  const running = result(start(w, "running-one", dir, file));
  expect(refusal(start(w, "running-one", dir, file))).toMatchObject({
    code: "name_taken",
    meta: {
      name: "running-one",
      state: "running",
      admits: [
        "agent-task wait running-one [--after <name>]... [--waits <text>]",
        "agent-task review running-one",
        "agent-task stop running-one",
        "agent-task done running-one",
      ],
    },
  });
  expect(listed(w)).toEqual([{ ...running, briefChanged: false }]);
  const first = result(start(w, "stopped-one", dir, file));
  result(run(w, w.root, ["stop", "stopped-one"]));
  const again = result(
    run(w, w.root, ["start", "stopped-one", "--repo", other, "--brief", file, "--session", "session-2"]),
  );
  expect(again).toMatchObject({
    name: "stopped-one",
    state: "running",
    repo: other,
    added: first.added,
    session: "session-2",
  });
  expect(Date.parse(String(again.started))).toBeGreaterThanOrEqual(Date.parse(String(first.started)));
  result(run(w, w.root, ["done", "stopped-one"]));
  const fresh = result(start(w, "stopped-one", dir, file));
  expect(fresh).toMatchObject({ repo: dir, session: null });
  expect(fresh.added).toBe(fresh.started);
  expect(ready(w)).toEqual([]);
});

test("AC-7 of several starts of one name at once, exactly one succeeds", async () => {
  const w = world();
  const file = brief(w.root);
  const repos = ["one", "two", "three", "four", "five"].map((name) => repo(w, name));
  const ran = await runAtOnce(
    w,
    w.root,
    repos.map((dir) => ["start", "same-name", "--repo", dir, "--brief", file]),
  );
  const won = ran.filter(({ exitCode }) => exitCode === 0);
  const [winner] = won;
  expect(won).toHaveLength(1);
  if (winner === undefined) throw new Error("no start succeeded");
  for (const lost of ran.filter(({ exitCode }) => exitCode !== 0))
    expect(refusal(lost)).toMatchObject({
      code: "name_taken",
      meta: { name: "same-name", state: "running" },
    });
  expect(listed(w)).toEqual([{ ...result(winner), briefChanged: false }]);
});

test("AC-8 list prints running tasks oldest first, reading each brief afresh to flag a changed or deleted one, and the stopped tasks as ready", () => {
  const w = world();
  const dir = repo(w);
  const amended = brief(w.root, "amended.md");
  const deleted = brief(w.root, "deleted.md");
  const kept = brief(w.root, "kept.md");
  for (const [name, file] of [
    ["zeta", amended],
    ["mu", deleted],
    ["gone", kept],
    ["paused", kept],
    ["alpha", kept],
  ] as const)
    result(start(w, name, dir, file));
  result(run(w, w.root, ["done", "gone"]));
  const paused = result(run(w, w.root, ["stop", "paused"]));
  const unchanged = (tasks: readonly Shown[]) => tasks.map(({ name, briefChanged }) => [name, briefChanged]);
  expect(unchanged(listed(w))).toEqual([
    ["zeta", false],
    ["mu", false],
    ["alpha", false],
  ]);
  writeFileSync(amended, "# Brief\n\nA fix.\n");
  rmSync(deleted);
  expect(unchanged(listed(w))).toEqual([
    ["zeta", true],
    ["mu", true],
    ["alpha", false],
  ]);
  expect(ready(w)).toEqual([paused]);
});

test("AC-9 stop takes a running task back to queued and done removes a task in either state; a wrong state, an unknown name and an invalid name are refused", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(w.root);
  const started = result(
    run(w, w.root, ["start", "task-a", "--repo", dir, "--brief", file, "--session", "s"]),
  );
  const stopped = result(run(w, w.root, ["stop", "task-a"]));
  expect(stopped).toEqual({
    name: "task-a",
    state: "queued",
    repo: dir,
    ...UNQUEUED,
    added: started.added,
    after: [],
  });
  expect(refusal(run(w, w.root, ["stop", "task-a"]))).toMatchObject({
    code: "wrong_state",
    meta: {
      name: "task-a",
      act: "stop",
      state: "queued",
      admits: [
        "agent-task add task-a --repo <path> --goal <text> [--plan <file>] [--priority urgent|high|medium|low] [--after <name>]... [--waits <text>]",
        "agent-task wait task-a [--after <name>]... [--waits <text>]",
        "agent-task start task-a --repo <path> --brief <file> [--session <id>]",
        "agent-task done task-a",
      ],
    },
  });
  expect(result(run(w, w.root, ["done", "task-a"]))).toEqual(stopped);
  expect(result(start(w, "task-b", dir, file))).toMatchObject({ state: "running" });
  expect(result(run(w, w.root, ["done", "task-b"]))).toMatchObject({ name: "task-b", state: "running" });
  for (const [act, name] of [
    ["stop", "task-a"],
    ["done", "task-a"],
    ["done", "task-b"],
  ] as const) {
    const unknown = refusal(run(w, w.root, [act, name]));
    expect(unknown).toMatchObject({ code: "unknown_task", meta: { name, act } });
    expect(unknown.resolve).toBe(`agent-task start ${name} --repo <path> --brief <file> [--session <id>]`);
  }
  for (const act of ["stop", "done"])
    expect(refusal(run(w, w.root, [act, "Task_A"]))).toMatchObject({
      code: "invalid_name",
      meta: { name: "Task_A" },
    });
  expect(listing(run(w, w.root, ["list"]))).toEqual({ tasks: [], ready: [], waiting: [] });
});

test("AC-10 add queues a task with its goal, plan, priority, after and waits, listed as waiting or ready, and refuses a bad plan, an unknown after name, a path outside git, itself as after and a bad priority, recording nothing", () => {
  const w = world();
  const dir = repo(w);
  const plan = brief(w.root, "plan.md", "# Plan\n");
  const first = result(add(w, "task-b", dir, "land first"));
  expect(first).toMatchObject({
    name: "task-b",
    state: "queued",
    repo: dir,
    ...UNQUEUED,
    goal: "land first",
    after: [],
  });
  expect(first.added).toBeDefined();
  const inside = join(dir, "inside");
  mkdirSync(inside);
  const full = result(
    add(
      w,
      "task-a",
      inside,
      "ship it",
      "--plan",
      "plan.md",
      "--priority",
      "high",
      "--after",
      "task-b",
      "--waits",
      "the owner's word",
    ),
  );
  expect(full).toMatchObject({
    name: "task-a",
    state: "queued",
    repo: dir,
    goal: "ship it",
    plan,
    priority: "high",
    waits: "the owner's word",
    after: ["task-b"],
  });
  expect(listing(run(w, w.root, ["list"]))).toEqual({ tasks: [], ready: [first], waiting: [full] });
  const unreadable = brief(w.root, "unreadable.md");
  chmodSync(unreadable, 0o000);
  for (const missing of [join(w.root, "missing.md"), unreadable, w.root])
    expect(refusal(add(w, "task-c", dir, "g", "--plan", missing))).toMatchObject({
      code: "plan_unreadable",
      meta: { plan: missing },
    });
  expect(refusal(add(w, "task-c", dir, "g", "--after", "task-z"))).toMatchObject({
    code: "unknown_task",
    meta: { name: "task-z", act: "add" },
    resolve: "agent-task start task-z --repo <path> --brief <file> [--session <id>]",
  });
  const outside = join(w.root, "outside");
  mkdirSync(outside);
  expect(refusal(add(w, "task-c", outside, "g"))).toMatchObject({ code: "not_a_checkout" });
  for (const flags of [
    ["--after", "task-c"],
    ["--priority", "top"],
  ]) {
    const usage = add(w, "task-c", dir, "g", ...flags);
    expect([usage.exitCode, usage.stdout]).toEqual([2, ""]);
    expect(JSON.parse(usage.stderr).error).toMatchObject({ kind: "usage", code: "bad_arguments" });
  }
  expect(names([...ready(w), ...waiting(w)])).toEqual(["task-b", "task-a"]);
});

test("AC-11 add on a queued name replaces its record keeping the added time, and on a running or in-review name is refused name_taken leaving it", () => {
  const w = world();
  const dir = repo(w);
  const other = repo(w, "other");
  const first = result(add(w, "task-a", dir, "first", "--priority", "low", "--waits", "a word"));
  const replaced = result(add(w, "task-a", other, "second"));
  expect(replaced).toEqual({
    name: "task-a",
    state: "queued",
    repo: other,
    goal: "second",
    plan: null,
    priority: null,
    waits: null,
    added: first.added,
    after: [],
  });
  const running = result(start(w, "task-b", dir, brief(w.root)));
  expect(refusal(add(w, "task-b", dir, "again"))).toMatchObject({
    code: "name_taken",
    meta: { name: "task-b", state: "running" },
  });
  result(start(w, "task-c", dir, brief(w.root)));
  const reviewed = result(run(w, w.root, ["review", "task-c"]));
  expect(refusal(add(w, "task-c", dir, "again"))).toMatchObject({
    code: "name_taken",
    meta: { name: "task-c", state: "review" },
  });
  expect(listed(w)).toEqual([
    { ...running, briefChanged: false },
    { ...reviewed, briefChanged: false },
  ]);
  expect(ready(w)).toEqual([replaced]);
});

test("AC-12 wait replaces what a task waits after and for, clears both given nothing, sets only the text on a running task, and refuses --after on a running task and an unknown name", () => {
  const w = world();
  const dir = repo(w);
  result(add(w, "task-b", dir, "b"));
  result(add(w, "task-c", dir, "c"));
  const queued = result(add(w, "task-a", dir, "a", "--after", "task-b", "--waits", "one"));
  expect(result(run(w, w.root, ["wait", "task-a", "--after", "task-c", "--waits", "two"]))).toEqual({
    ...queued,
    after: ["task-c"],
    waits: "two",
  });
  expect(result(run(w, w.root, ["wait", "task-a"]))).toEqual({ ...queued, after: [], waits: null });
  const running = result(start(w, "task-d", dir, brief(w.root)));
  expect(result(run(w, w.root, ["wait", "task-d", "--waits", "a review"]))).toEqual({
    ...running,
    waits: "a review",
  });
  expect(refusal(run(w, w.root, ["wait", "task-d", "--after", "task-b"]))).toMatchObject({
    code: "wrong_state",
    meta: { name: "task-d", act: "wait", state: "running" },
  });
  expect(refusal(run(w, w.root, ["wait", "task-z", "--waits", "x"]))).toMatchObject({
    code: "unknown_task",
    meta: { name: "task-z", act: "wait" },
  });
  expect(listed(w)).toEqual([{ ...running, waits: "a review", briefChanged: false }]);
});

test("AC-13 start of a queued task is refused blocked while a name it waits after is held, and once each is done runs it keeping its goal, plan, priority, waits and added time and waiting after nothing", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(w.root);
  const plan = brief(w.root, "plan.md", "# Plan\n");
  result(add(w, "task-b", dir, "b"));
  result(start(w, "task-c", dir, file));
  const queued = result(
    add(
      w,
      "task-a",
      dir,
      "a",
      "--plan",
      plan,
      "--priority",
      "urgent",
      "--after",
      "task-b",
      "--after",
      "task-c",
      "--waits",
      "ci",
    ),
  );
  const blocked = refusal(start(w, "task-a", dir, file));
  expect(blocked).toMatchObject({ code: "blocked", meta: { name: "task-a", after: ["task-b", "task-c"] } });
  expect(blocked.resolve).toBe(
    "agent-task done task-b; agent-task done task-c once each has landed, or agent-task wait task-a [--after <name>]... [--waits <text>] to wait after fewer",
  );
  expect(waiting(w)).toEqual([queued]);
  result(run(w, w.root, ["done", "task-b"]));
  expect(refusal(start(w, "task-a", dir, file))).toMatchObject({ meta: { after: ["task-c"] } });
  result(run(w, w.root, ["done", "task-c"]));
  const running = result(
    run(w, w.root, ["start", "task-a", "--repo", dir, "--brief", file, "--session", "s1"]),
  );
  expect(running).toMatchObject({
    name: "task-a",
    state: "running",
    repo: dir,
    goal: "a",
    plan,
    priority: "urgent",
    waits: "ci",
    added: queued.added,
    brief: file,
    session: "s1",
  });
  expect(running.after).toBeUndefined();
  expect(listing(run(w, w.root, ["list"]))).toEqual({
    tasks: [{ ...running, briefChanged: false }],
    ready: [],
    waiting: [],
  });
});

test("AC-14 list orders ready and waiting by priority with none last, then added time, then name; done of a name frees what waited after it, and add of the name again blocks them again", () => {
  const w = world();
  const dir = repo(w);
  result(add(w, "low", dir, "g", "--priority", "low"));
  result(add(w, "none-b", dir, "g"));
  result(add(w, "none-a", dir, "g"));
  result(add(w, "urgent", dir, "g", "--priority", "urgent"));
  result(add(w, "high", dir, "g", "--priority", "high"));
  result(add(w, "medium", dir, "g", "--priority", "medium", "--waits", "a word"));
  result(add(w, "after-low", dir, "g", "--after", "low"));
  expect(names(ready(w))).toEqual(["urgent", "high", "low", "none-b", "none-a"]);
  expect(names(waiting(w))).toEqual(["medium", "after-low"]);
  result(run(w, w.root, ["done", "low"]));
  expect(names(ready(w))).toEqual(["urgent", "high", "none-b", "none-a", "after-low"]);
  expect(waiting(w).map(({ name, after }) => [name, after])).toEqual([["medium", []]]);
  result(add(w, "low", dir, "g"));
  expect(waiting(w).map(({ name, after }) => [name, after])).toEqual([
    ["medium", []],
    ["after-low", ["low"]],
  ]);
});

test("AC-15 review takes a running task to review with the time, keeps it listed and its brief frozen, refuses review again, of a queued or unknown name, and start of its name; wait sets its text; stop takes it back to queued forgetting the review time; done removes it", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(w.root);
  const running = result(start(w, "task-a", dir, file));
  const reviewed = result(run(w, w.root, ["review", "task-a"]));
  expect(reviewed).toMatchObject({ ...running, state: "review" });
  expect(Date.parse(String(reviewed.reviewed))).toBeGreaterThanOrEqual(Date.parse(String(running.started)));
  expect(listed(w)).toEqual([{ ...reviewed, briefChanged: false }]);
  expect(refusal(run(w, w.root, ["review", "task-a"]))).toMatchObject({
    code: "wrong_state",
    meta: {
      name: "task-a",
      act: "review",
      state: "review",
      admits: [
        "agent-task wait task-a [--after <name>]... [--waits <text>]",
        "agent-task stop task-a",
        "agent-task done task-a",
      ],
    },
  });
  result(add(w, "task-b", dir, "b"));
  expect(refusal(run(w, w.root, ["review", "task-b"]))).toMatchObject({
    code: "wrong_state",
    meta: { name: "task-b", act: "review", state: "queued" },
  });
  expect(refusal(run(w, w.root, ["review", "task-c"]))).toMatchObject({
    code: "unknown_task",
    meta: { name: "task-c", act: "review" },
  });
  expect(refusal(start(w, "task-a", dir, file))).toMatchObject({
    code: "name_taken",
    meta: { name: "task-a", state: "review" },
  });
  expect(result(run(w, w.root, ["wait", "task-a", "--waits", "the owner"]))).toEqual({
    ...reviewed,
    waits: "the owner",
  });
  expect(result(run(w, w.root, ["stop", "task-a"]))).toEqual({
    name: "task-a",
    state: "queued",
    repo: dir,
    ...UNQUEUED,
    waits: "the owner",
    added: running.added,
    after: [],
  });
  const again = result(start(w, "task-a", dir, file));
  result(run(w, w.root, ["review", "task-a"]));
  expect(result(run(w, w.root, ["done", "task-a"]))).toMatchObject({ ...again, state: "review" });
  expect(listed(w)).toEqual([]);
});

test("AC-16 a store of a schema version this agent-task cannot read is refused and left as it is", () => {
  const w = world();
  const path = storeOfVersion(w, 3);
  const before = readFileSync(path);
  expect(refusal(run(w, w.root, ["list"]))).toMatchObject({ code: "store_version", meta: { found: 3 } });
  expect(readFileSync(path).equals(before)).toBe(true);
});

test("AC-17 a version-1 store is migrated by the first command that opens it, keeping every running task and freeing the ended names", () => {
  const w = world();
  const dir = repo(w);
  const kept = brief(w.root, "kept.md");
  const amended = brief(w.root, "amended.md");
  const path = storeOfVersion(w, 1, VERSION_ONE);
  const db = new Database(path);
  const insert = db.query(
    "INSERT INTO tasks (name, repo, brief, brief_sha, started_at, state, ended_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const ended = "2026-10-14T09:00:00.000Z";
  insert.run("old-b", dir, amended, BRIEF_SHA, "2026-10-15T09:00:00.000Z", "running", null, null);
  insert.run("old-a", dir, kept, BRIEF_SHA, "2026-10-15T08:00:00.000Z", "running", null, null);
  insert.run("old-done", dir, kept, BRIEF_SHA, "2026-10-14T08:00:00.000Z", "done", ended, null);
  insert.run("old-dropped", dir, kept, BRIEF_SHA, "2026-10-14T08:00:00.000Z", "dropped", ended, "given up");
  db.run("INSERT INTO task_commits VALUES ('old-done', 'abcdef0')");
  db.close();
  writeFileSync(amended, "# Brief\n\nA fix.\n");
  const migrated = { repo: dir, briefSha: BRIEF_SHA, session: null, state: "running", ...UNQUEUED };
  expect(listing(run(w, w.root, ["list"]))).toEqual({
    tasks: [
      {
        ...migrated,
        name: "old-a",
        brief: kept,
        added: "2026-10-15T08:00:00.000Z",
        started: "2026-10-15T08:00:00.000Z",
        briefChanged: false,
      },
      {
        ...migrated,
        name: "old-b",
        brief: amended,
        added: "2026-10-15T09:00:00.000Z",
        started: "2026-10-15T09:00:00.000Z",
        briefChanged: true,
      },
    ],
    ready: [],
    waiting: [],
  });
  const reopened = new Database(path, { readonly: true });
  expect(reopened.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
  expect(
    reopened
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all(),
  ).toEqual([{ name: "task_after" }, { name: "tasks" }]);
  expect(result(run(w, w.root, ["review", "old-a"]))).toMatchObject({ state: "review" });
  reopened.close();
  for (const name of ["old-done", "old-dropped"])
    expect(result(start(w, name, dir, kept))).toMatchObject({ name, state: "running" });
  expect(refusal(start(w, "old-a", dir, kept))).toMatchObject({ code: "name_taken" });
});

test("AC-22 every command runs with git as the only program on PATH, and doctor names the hooks' missing programs", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(w.root);
  const bin = binWith(w, ["git"], false);
  const options = { env: { PATH: bin } };
  for (const args of [
    ["add", "task-c", "--repo", dir, "--goal", "g", "--plan", file, "--priority", "low"],
    ["start", "task-a", "--repo", dir, "--brief", file],
    ["start", "task-b", "--repo", dir, "--brief", file, "--session", "s"],
    ["wait", "task-c", "--after", "task-a", "--waits", "w"],
    ["review", "task-b"],
    ["list"],
    ["stop", "task-a"],
    ["done", "task-a"],
    ["done", "task-b"],
    ["done", "task-c"],
  ])
    expect(run(w, w.root, args, options).exitCode).toBe(0);
  const { checks } = result(run(w, w.root, ["doctor"], options));
  if (!Array.isArray(checks)) throw new Error("doctor prints its checks");
  const byName = new Map(checks.map((check) => [check.name, check]));
  expect(byName.get("git")).toEqual({
    name: "git",
    state: "ok",
    detail: `found at ${join(bin, "git")}`,
    fix: null,
  });
  for (const program of ["bash", "agent-task", "jq", "realpath"]) {
    const check = byName.get(program);
    expect(check).toMatchObject({ name: program, state: "warn" });
    expect(check.detail).toContain(`not found in ${bin}`);
    expect(check.detail).toContain("before-edit.sh");
    expect(check.detail).toContain("session-start.sh");
    expect(check.fix).toContain(program);
  }
});
