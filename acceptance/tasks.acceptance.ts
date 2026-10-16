import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  brief,
  commit,
  git,
  listedTasks,
  origin,
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

function listed(w: World): readonly Shown[] {
  return listedTasks(run(w, w.root, ["list"]));
}

function start(w: World, name: string, at: string, briefPath: string, cwd = w.root): Ran {
  return run(w, cwd, ["start", name, "--repo", at, "--brief", briefPath]);
}

function landedRepo(w: World, name = "repo"): string {
  const dir = repo(w, name);
  origin(w, dir, `${name}-origin.git`);
  return dir;
}

test("AC-1 start records the task in the store under XDG_DATA_HOME, and list prints it unchanged", () => {
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
  });
  expect(Date.parse(String(started.started))).toBeGreaterThanOrEqual(before - 1000);
  expect(existsSync(join(w.root, "data", "agent-task", "tasks.db"))).toBe(true);
  expect(listed(w)).toEqual([{ ...started, briefChanged: false }]);
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

test("AC-3 start from inside the repository and from a linked worktree records the main working tree, and done closes it once landed", () => {
  const w = world();
  const dir = landedRepo(w);
  const file = brief(w.root);
  const inside = join(dir, "inside");
  mkdirSync(inside);
  expect(result(start(w, "from-inside", "inside", file, dir))).toMatchObject({ repo: dir });
  const linked = join(w.root, "linked");
  git(w, dir, ["worktree", "add", "-q", "-b", "topic", linked]);
  expect(result(start(w, "from-linked", linked, file))).toMatchObject({ repo: dir });
  const sha = commit(w, linked, "work");
  git(w, linked, ["push", "-q", "origin", "topic:main"]);
  git(w, dir, ["worktree", "remove", linked]);
  expect(result(run(w, w.root, ["done", "from-linked", "--commit", sha]))).toMatchObject({
    name: "from-linked",
    state: "done",
    commits: [sha],
  });
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

test("AC-6 start refuses a name the store holds in any state, naming the state and what it admits", () => {
  const w = world();
  const dir = landedRepo(w);
  const file = brief(w.root);
  const head = git(w, dir, ["rev-parse", "HEAD"]);
  const running = result(start(w, "running-one", dir, file));
  result(start(w, "done-one", dir, file));
  result(run(w, w.root, ["done", "done-one", "--commit", head]));
  result(start(w, "dropped-one", dir, file));
  result(run(w, w.root, ["drop", "dropped-one", "--reason", "given up"]));
  expect(refusal(start(w, "running-one", dir, file))).toMatchObject({
    code: "name_taken",
    meta: {
      name: "running-one",
      state: "running",
      admits: [
        "agent-task done running-one --commit <sha>...",
        "agent-task drop running-one --reason <text>",
      ],
    },
  });
  for (const [name, state] of [
    ["done-one", "done"],
    ["dropped-one", "dropped"],
  ]) {
    expect(refusal(start(w, String(name), dir, file))).toMatchObject({
      code: "name_taken",
      meta: { name, state, admits: [] },
    });
  }
  expect(listed(w)).toEqual([{ ...running, briefChanged: false }]);
});

test("AC-7 of several starts of one name at once, exactly one succeeds", async () => {
  const w = world();
  const file = brief(w.root);
  result(run(w, w.root, ["list"]));
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

test("AC-8 list prints running tasks oldest first, reading each brief afresh to flag a changed or deleted one", () => {
  const w = world();
  const dir = repo(w);
  const amended = brief(w.root, "amended.md");
  const deleted = brief(w.root, "deleted.md");
  const kept = brief(w.root, "kept.md");
  for (const [name, file] of [
    ["first", amended],
    ["second", deleted],
    ["gone", kept],
    ["third", kept],
  ] as const) {
    result(start(w, name, dir, file));
    Bun.sleepSync(5);
  }
  result(run(w, w.root, ["drop", "gone", "--reason", "worker died"]));
  const unchanged = (tasks: readonly Shown[]) => tasks.map(({ name, briefChanged }) => [name, briefChanged]);
  expect(unchanged(listed(w))).toEqual([
    ["first", false],
    ["second", false],
    ["third", false],
  ]);
  writeFileSync(amended, "# Brief\n\nA fix.\n");
  rmSync(deleted);
  expect(unchanged(listed(w))).toEqual([
    ["first", true],
    ["second", true],
    ["third", false],
  ]);
});

test("AC-9 done closes a task only when every sha is on origin's default branch, recording each full sha once", () => {
  const w = world();
  const dir = landedRepo(w);
  const file = brief(w.root);
  const pushed = commit(w, dir, "pushed");
  git(w, dir, ["push", "-q", "origin", "main"]);
  result(start(w, "task-a", dir, file));
  const closed = result(
    run(w, w.root, ["done", "task-a", "--commit", pushed.slice(0, 8), "--commit", pushed]),
  );
  expect(closed).toMatchObject({ name: "task-a", state: "done", commits: [pushed] });
  expect(listed(w)).toEqual([]);

  result(start(w, "task-b", dir, file));
  const unpushed = commit(w, dir, "unpushed");
  const unknown = "0123456789abcdef0123456789abcdef01234567";
  const args = ["done", "task-b", "--commit", pushed, "--commit", unpushed];
  expect(refusal(run(w, w.root, [...args, "--commit", unknown]))).toMatchObject({
    code: "not_landed",
    meta: { name: "task-b", branch: "origin/main", unknown: [unknown], unmerged: [unpushed] },
  });
  expect(listed(w).map(({ name }) => name)).toEqual(["task-b"]);
  git(w, dir, ["push", "-q", "origin", "main"]);
  expect(result(run(w, w.root, args))).toMatchObject({ state: "done", commits: [pushed, unpushed] });
});

test("AC-10 done refuses a repository with no origin, an unreachable origin, an origin with no default branch and a moved repository", () => {
  const w = world();
  const file = brief(w.root);
  const lone = repo(w, "lone");
  const unreachable = repo(w, "unreachable");
  git(w, unreachable, ["remote", "add", "origin", join(w.root, "nowhere.git")]);
  const headless = landedRepo(w, "headless");
  git(w, join(w.root, "headless-origin.git"), ["symbolic-ref", "HEAD", "refs/heads/nothing"]);
  const moved = landedRepo(w, "moved");
  const cases = [
    ["lone", lone, "no_origin"],
    ["unreachable", unreachable, "remote_unreachable"],
    ["headless", headless, "no_default_branch"],
    ["moved", moved, "repo_missing"],
  ] as const;
  for (const [name, dir] of cases) result(start(w, name, dir, file));
  renameSync(moved, join(w.root, "moved-away"));
  for (const [name, dir, code] of cases) {
    const head = git(w, existsSync(dir) ? dir : join(w.root, "moved-away"), ["rev-parse", "HEAD"]);
    const refused = refusal(run(w, w.root, ["done", name, "--commit", head]));
    expect(refused).toMatchObject({ code });
    if (code === "repo_missing") expect(refused.resolve).toContain(`agent-task drop ${name} --reason <text>`);
  }
  expect(listed(w).map(({ name }) => name)).toEqual(["lone", "unreachable", "headless", "moved"]);
});

test("AC-11 drop ends a running task with its reason; an ended, unknown or invalid name is refused", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(w.root);
  result(start(w, "task-a", dir, file));
  expect(result(run(w, w.root, ["drop", "task-a", "--reason", "worker died"]))).toMatchObject({
    name: "task-a",
    state: "dropped",
    reason: "worker died",
  });
  for (const args of [
    ["drop", "task-a", "--reason", "again"],
    ["done", "task-a", "--commit", "abc"],
  ]) {
    expect(refusal(run(w, w.root, args))).toMatchObject({
      code: "not_running",
      meta: { name: "task-a", state: "dropped", admits: [] },
    });
  }
  const unknown = refusal(run(w, w.root, ["drop", "nobody", "--reason", "x"]));
  expect(unknown).toMatchObject({ code: "unknown_task", meta: { name: "nobody", act: "drop" } });
  expect(unknown.resolve).toBe("agent-task start nobody --repo <path> --brief <file>");
  for (const args of [
    ["drop", "Task_A", "--reason", "x"],
    ["done", "Task_A", "--commit", "abc"],
  ])
    expect(refusal(run(w, w.root, args))).toMatchObject({ code: "invalid_name", meta: { name: "Task_A" } });
  expect(listed(w)).toEqual([]);
});

test("AC-12 a store of another schema version is refused and left as it is", () => {
  const w = world();
  const dir = join(w.root, "data", "agent-task");
  mkdirSync(dir);
  const path = join(dir, "tasks.db");
  const db = new Database(path);
  db.run("PRAGMA user_version = 2");
  db.close();
  const before = readFileSync(path);
  expect(refusal(run(w, w.root, ["list"]))).toMatchObject({ code: "store_version", meta: { found: 2 } });
  expect(readFileSync(path).equals(before)).toBe(true);
});

test("AC-17 every command runs with git as the only program on PATH", () => {
  const w = world();
  const dir = landedRepo(w);
  const file = brief(w.root);
  const bin = join(w.root, "bin");
  mkdirSync(bin);
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  const options = { env: { PATH: bin } };
  const head = git(w, dir, ["rev-parse", "HEAD"]);
  for (const args of [
    ["start", "task-a", "--repo", dir, "--brief", file],
    ["start", "task-b", "--repo", dir, "--brief", file],
    ["list"],
    ["done", "task-a", "--commit", head],
    ["drop", "task-b", "--reason", "given up"],
  ])
    expect(run(w, w.root, args, options).exitCode).toBe(0);
});
