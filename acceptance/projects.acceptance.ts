import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import {
  brief,
  listing,
  type Ran,
  refusal,
  removeScratchDirs,
  repo,
  result,
  run,
  type Shown,
  shownListAt,
  type World,
  world,
} from "./harness";

afterEach(removeScratchDirs);

const UNKNOWN_PROJECT_ACT =
  "agent-task project add nowhere --name <text> --repo <path> --dir <dir> first; agent-task project list lists the projects";

function project(w: World, id: string, at: string, dir = at, cwd = w.root): Ran {
  return run(w, cwd, ["project", "add", id, "--name", `The ${id}`, "--repo", at, "--dir", dir]);
}

function names(tasks: readonly Shown[]): readonly unknown[] {
  return tasks.map(({ name }) => name);
}

function projectsOf(w: World): Shown {
  return result(run(w, w.root, ["project", "list"]));
}

test("AC-41 project add records a project with its main working tree and directory and replaces it on its id, refusing a bad id, repository or directory, and project list prints them as a table", () => {
  const w = world();
  const dir = repo(w);
  mkdirSync(join(dir, "sub"));
  mkdirSync(join(dir, "briefs"));
  const added = result(
    run(w, join(dir, "sub"), [
      "project",
      "add",
      "site",
      "--name",
      "The site",
      "--repo",
      ".",
      "--dir",
      "../briefs",
    ]),
  );
  expect(added).toEqual({ id: "site", name: "The site", repo: dir, dir: join(dir, "briefs") });
  const other = repo(w, "other");
  const replaced = { id: "site", name: "The new site", repo: other, dir: join(dir, "briefs") };
  expect(
    result(
      run(w, w.root, [
        "project",
        "add",
        "site",
        "--name",
        "The new site",
        "--repo",
        other,
        "--dir",
        replaced.dir,
      ]),
    ),
  ).toEqual(replaced);
  expect(refusal(project(w, "Site_1", dir))).toMatchObject({
    code: "invalid_project",
    meta: { id: "Site_1" },
  });
  const outside = join(w.root, "outside");
  mkdirSync(outside);
  expect(refusal(project(w, "app", outside))).toMatchObject({ code: "not_a_checkout" });
  const file = brief(dir);
  expect(refusal(project(w, "app", dir, file))).toMatchObject({ code: "dir_missing", meta: { dir: file } });
  const blank = run(w, w.root, ["project", "add", "app", "--name", " ", "--repo", dir, "--dir", dir]);
  expect([blank.exitCode, blank.stdout]).toEqual([2, ""]);
  expect(decode(blank.stderr)).toMatchObject({ error: { code: "bad_arguments" } });
  const listed = run(w, w.root, ["project", "list"]);
  expect(result(listed)).toEqual({ counts: { projects: 1 }, projects: [replaced] });
  expect(listed.stdout).toContain("\n  projects[1]{id,name,repo,dir}:\n");
});

test("AC-42 add, start and map record a task's project, and each refuses a project the store does not hold, recording nothing", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(dir);
  result(project(w, "site", dir));
  result(project(w, "app", dir));
  expect(
    result(run(w, w.root, ["add", "task-a", "--repo", dir, "--goal", "do a", "--project", "site"])),
  ).toMatchObject({
    project: "site",
  });
  expect(
    result(run(w, w.root, ["start", "task-b", "--repo", dir, "--brief", file, "--project", "app"])),
  ).toMatchObject({ project: "app" });
  expect(result(run(w, w.root, ["start", "task-a", "--repo", dir, "--brief", file]))).toMatchObject({
    project: "site",
  });
  expect(result(run(w, w.root, ["map", "task-b", "--project", "site"]))).toMatchObject({
    name: "task-b",
    state: "running",
    project: "site",
  });
  for (const args of [
    ["add", "task-c", "--repo", dir, "--goal", "do c", "--project", "nowhere"],
    ["start", "task-c", "--repo", dir, "--brief", file, "--project", "nowhere"],
    ["map", "task-b", "--project", "nowhere"],
  ])
    expect(refusal(run(w, w.root, args))).toMatchObject({
      code: "unknown_project",
      meta: { id: "nowhere" },
      resolve: UNKNOWN_PROJECT_ACT,
    });
  expect(refusal(run(w, w.root, ["map", "task-z", "--project", "site"]))).toMatchObject({
    code: "unknown_task",
    meta: { name: "task-z", act: "map" },
  });
  const full = listing(run(w, w.root, ["list", "--full"]));
  expect(full.tasks.map(({ name, project: id }) => [name, id])).toEqual([
    ["task-b", "site"],
    ["task-a", "site"],
  ]);
  expect([...full.ready, ...full.waiting]).toEqual([]);
});

test("AC-43 list --project prints only that project's tasks and counts, list prints each task's project, and an unknown project is refused", () => {
  const w = world();
  const dir = repo(w);
  result(project(w, "site", dir));
  result(project(w, "app", dir));
  for (const id of ["site", "app"]) {
    result(
      run(w, w.root, [
        "start",
        `run-${id}`,
        "--repo",
        dir,
        "--brief",
        brief(dir, `${id}.md`),
        "--project",
        id,
      ]),
    );
    result(run(w, w.root, ["add", `ready-${id}`, "--repo", dir, "--goal", "go", "--project", id]));
    result(
      run(w, w.root, [
        "add",
        `waiting-${id}`,
        "--repo",
        dir,
        "--goal",
        "go",
        "--project",
        id,
        "--waits",
        "the owner",
      ]),
    );
  }
  result(run(w, w.root, ["add", "ready-none", "--repo", dir, "--goal", "go"]));
  for (const id of ["site", "app"]) {
    const filtered = result(run(w, w.root, ["list", "--project", id]));
    expect(filtered.counts).toEqual({ running: 1, review: 0, ready: 1, waiting: 1 });
    const shown = listing(run(w, w.root, ["list", "--project", id]));
    expect([names(shown.tasks), names(shown.ready), names(shown.waiting)]).toEqual([
      [`run-${id}`],
      [`ready-${id}`],
      [`waiting-${id}`],
    ]);
  }
  const all = listing(run(w, w.root, ["list"]));
  expect(all.ready.map(({ name, project: id }) => [name, id])).toEqual([
    ["ready-site", "site"],
    ["ready-app", "app"],
    ["ready-none", null],
  ]);
  expect(
    names(shownListAt(result(run(w, w.root, ["list", "--started", "--project", "app"])), "tasks")),
  ).toEqual(["run-app"]);
  expect(refusal(run(w, w.root, ["list", "--project", "nowhere"]))).toMatchObject({
    code: "unknown_project",
  });
});

test("AC-44 project remove refuses a project a task belongs to, naming map and done, removes it once none does, and a halt refuses map, project add and project remove", () => {
  const w = world();
  const dir = repo(w);
  result(project(w, "site", dir));
  result(run(w, w.root, ["add", "task-a", "--repo", dir, "--goal", "do a", "--project", "site"]));
  const before = projectsOf(w);
  expect(refusal(run(w, w.root, ["project", "remove", "site"]))).toMatchObject({
    code: "project_in_use",
    meta: { id: "site", tasks: ["task-a"] },
    resolve: "agent-task map task-a --project <id> or agent-task done task-a, then remove the project again",
  });
  expect(projectsOf(w)).toEqual(before);
  result(run(w, w.root, ["done", "task-a"]));
  expect(result(run(w, w.root, ["project", "remove", "site"]))).toEqual({
    id: "site",
    name: "The site",
    repo: dir,
    dir,
  });
  expect(projectsOf(w)).toEqual({ counts: { projects: 0 }, projects: [] });
  expect(refusal(run(w, w.root, ["project", "remove", "site"]))).toMatchObject({ code: "unknown_project" });
  result(project(w, "kept", dir));
  result(run(w, w.root, ["add", "task-b", "--repo", dir, "--goal", "do b"]));
  result(run(w, w.root, ["halt", "a flaw in the workflow"]));
  for (const args of [
    ["map", "task-b", "--project", "kept"],
    ["project", "add", "app", "--name", "The app", "--repo", dir, "--dir", dir],
    ["project", "remove", "kept"],
  ])
    expect(refusal(run(w, w.root, args))).toMatchObject({ code: "halted" });
  expect(projectsOf(w)).toMatchObject({ projects: [{ id: "kept" }] });
  expect(listing(run(w, w.root, ["list", "--full"])).ready).toMatchObject([
    { name: "task-b", project: null },
  ]);
});

const VERSION_THREE = `
CREATE TABLE tasks (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'review')),
  repo TEXT NOT NULL,
  goal TEXT,
  plan TEXT,
  priority TEXT CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
  waits TEXT,
  added_at TEXT NOT NULL,
  brief TEXT,
  brief_sha TEXT,
  session TEXT,
  started_at TEXT,
  reviewed_at TEXT,
  until TEXT CHECK (state = 'queued' OR until IS NULL),
  CHECK ((state = 'queued') = (brief IS NULL)),
  CHECK ((state = 'review') = (reviewed_at IS NOT NULL)),
  CHECK ((brief IS NULL) = (brief_sha IS NULL)),
  CHECK ((brief IS NULL) = (started_at IS NULL)),
  CHECK (brief IS NOT NULL OR session IS NULL)
) STRICT;
CREATE TABLE task_after (
  task TEXT NOT NULL REFERENCES tasks (name) ON DELETE CASCADE,
  after TEXT NOT NULL,
  PRIMARY KEY (task, after)
) STRICT;
`;

test("AC-45 a version-3 store is migrated by the first command that opens it, keeping its tasks in no project", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(dir);
  const store = join(w.root, "data", "agent-task");
  mkdirSync(store, { recursive: true });
  const path = join(store, "tasks.db");
  const added = "2026-10-15T08:00:00.000Z";
  const db = new Database(path);
  db.run(VERSION_THREE);
  db.run(
    "INSERT INTO tasks VALUES ('queued-one', 'queued', ?, 'ship it', NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, 'exit 0')",
    [dir, added],
  );
  db.run(
    "INSERT INTO tasks VALUES ('running-one', 'running', ?, NULL, NULL, NULL, NULL, ?, ?, 'sha', NULL, ?, NULL, NULL)",
    [dir, added, file, added],
  );
  db.run("INSERT INTO task_after VALUES ('queued-one', 'running-one')");
  db.run("PRAGMA user_version = 3");
  db.close();
  const full = listing(run(w, w.root, ["list", "--full"]));
  expect(full.tasks).toMatchObject([
    { name: "running-one", project: null, state: "running", briefSha: "sha" },
  ]);
  expect(full.waiting).toMatchObject([
    {
      name: "queued-one",
      project: null,
      goal: "ship it",
      after: ["running-one"],
      until: "exit 0",
      untilState: "met",
    },
  ]);
  expect(projectsOf(w)).toEqual({ counts: { projects: 0 }, projects: [] });
  const reopened = new Database(path, { readonly: true });
  expect(reopened.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(4);
  reopened.close();
});
