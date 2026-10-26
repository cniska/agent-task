import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import {
  binWith,
  brief,
  field,
  git,
  type Ran,
  removeScratchDirs,
  repo,
  run,
  type Shown,
  shownAt,
  shownListAt,
  type World,
  world,
} from "./harness";

afterEach(removeScratchDirs);

type Check = {
  readonly name: string;
  readonly state: string;
  readonly detail: string;
  readonly fix: string | null;
};

type Report = { readonly checks: readonly Check[]; readonly failing: number };

const PROGRAMS = ["bash", "git", "jq"];

function isCheck(value: Shown): value is Check {
  const { name, state, detail, fix } = value;
  return (
    typeof name === "string" &&
    typeof state === "string" &&
    typeof detail === "string" &&
    (typeof fix === "string" || fix === null)
  );
}

function report(ran: Ran, status: number): Report {
  expect([ran.exitCode, ran.stderr]).toEqual([status, ""]);
  const shown = decode(ran.stdout);
  expect(shown).toMatchObject({ command: "doctor", ok: true });
  const result = shownAt(shown, "result");
  const checks = shownListAt(result, "checks");
  const failing = field(shownAt(result, "count"), "fail");
  if (!checks.every(isCheck) || typeof failing !== "number")
    throw new Error(`doctor printed no report: ${ran.stdout}`);
  return { checks, failing };
}

function check(printed: Report, name: string): Check {
  const found = printed.checks.find((one) => one.name === name);
  if (found === undefined) throw new Error(`doctor reports no ${name} check`);
  return found;
}

function doctor(w: World, bin: string, status: number): Report {
  return report(run(w, w.root, ["doctor", "--full"], { env: { PATH: bin } }), status);
}

function started(w: World, name: string, dir: string, file: string): void {
  expect(run(w, w.root, ["start", name, "--repo", dir, "--brief", file]).exitCode).toBe(0);
}

test("AC-26 doctor passes with no store and makes none, warns a version-1 and a version-2 store naming list, and fails one it cannot read, leaving each", () => {
  const w = world();
  const bin = binWith(w, PROGRAMS, true);
  const fresh = doctor(w, bin, 0);
  expect(fresh.failing).toBe(0);
  expect(fresh.checks.map(({ name }) => name)).toEqual(["store", "bash", "agent-task", "jq", "git"]);
  for (const one of fresh.checks) expect([one.name, one.state, one.fix]).toEqual([one.name, "ok", null]);
  expect(check(fresh, "jq").detail).toBe(`found at ${join(bin, "jq")}`);
  expect(existsSync(join(w.root, "data", "agent-task"))).toBe(false);
  const dir = join(w.root, "data", "agent-task");
  mkdirSync(dir);
  const path = join(dir, "tasks.db");
  const versioned = (version: number) => {
    const db = new Database(path);
    db.run(`PRAGMA user_version = ${version}`);
    db.close();
    return readFileSync(path);
  };
  for (const version of [1, 2]) {
    const old = versioned(version);
    const migratable = doctor(w, bin, 0);
    expect(migratable.failing).toBe(0);
    expect(check(migratable, "store")).toEqual({
      name: "store",
      state: "warn",
      detail: `${path} is a version ${version} store; this agent-task reads version 3`,
      fix: "run agent-task list, which migrates it, then run agent-task doctor again",
    });
    expect(readFileSync(path).equals(old)).toBe(true);
  }
  const newer = versioned(4);
  const other = doctor(w, bin, 1);
  expect(other.failing).toBe(1);
  expect(check(other, "store")).toEqual({
    name: "store",
    state: "fail",
    detail: `${path} holds store version 4, and this agent-task reads version 3`,
    fix: "stop and hand this error to the owner: run the agent-task that wrote this store",
  });
  expect(readFileSync(path).equals(newer)).toBe(true);
});

test("AC-27 doctor without git on PATH fails git and leaves each task's repository unchecked", () => {
  const w = world();
  const dir = repo(w);
  started(w, "task-a", dir, brief(w.root));
  const printed = doctor(w, binWith(w, [], false), 1);
  expect(check(printed, "git")).toMatchObject({ state: "fail" });
  expect(check(printed, "task-a repository")).toMatchObject({ state: "warn" });
  expect(check(printed, "task-a repository").detail).toContain("git is not on PATH");
  expect(printed.failing).toBe(1);
});

test("AC-28 doctor judges each task's repository, each running or in-review task's brief and each plan a task names, without contacting a remote", () => {
  const w = world();
  const briefs = join(w.root, "briefs");
  mkdirSync(briefs);
  const nowhere = join(w.root, "nowhere.git");
  const healthy = repo(w, "healthy");
  git(w, healthy, ["remote", "add", "origin", nowhere]);
  const readable = brief(briefs, "a.md");
  started(w, "task-a", healthy, readable);
  started(w, "task-b", repo(w, "no-origin"), brief(briefs, "b.md"));
  const moved = repo(w, "moved");
  git(w, moved, ["remote", "add", "origin", nowhere]);
  started(w, "task-c", moved, brief(briefs, "c.md"));
  renameSync(moved, join(w.root, "elsewhere"));
  const outer = repo(w, "outer");
  git(w, outer, ["remote", "add", "origin", nowhere]);
  const inner = join(outer, "inner");
  mkdirSync(inner);
  git(w, inner, ["init", "-q", "-b", "main"]);
  started(w, "task-d", inner, brief(briefs, "d.md"));
  rmSync(join(inner, ".git"), { recursive: true });
  const kept = repo(w, "kept");
  git(w, kept, ["remote", "add", "origin", nowhere]);
  const gone = brief(briefs, "e.md");
  started(w, "task-e", kept, gone);
  rmSync(gone);
  const stopped = repo(w, "stopped");
  started(w, "task-f", stopped, brief(briefs, "f.md"));
  expect(run(w, w.root, ["stop", "task-f"]).exitCode).toBe(0);
  rmSync(stopped, { recursive: true });
  expect(run(w, w.root, ["review", "task-b"]).exitCode).toBe(0);
  const plan = brief(briefs, "plan.md", "# Plan\n");
  const lost = join(briefs, "lost.md");
  const add = (name: string, at: string, file: string) =>
    run(w, w.root, ["add", name, "--repo", at, "--goal", "g", "--plan", file]);
  expect(add("task-g", healthy, plan).exitCode).toBe(0);
  expect(add("task-h", healthy, brief(briefs, "lost.md")).exitCode).toBe(0);
  rmSync(lost);
  const printed = doctor(w, binWith(w, PROGRAMS, true), 1);
  expect(printed.checks.map(({ name }) => name).slice(5)).toEqual([
    "task-a repository",
    "task-b repository",
    "task-c repository",
    "task-d repository",
    "task-e repository",
    "task-f repository",
    "task-g repository",
    "task-h repository",
    "task-a brief",
    "task-b brief",
    "task-c brief",
    "task-d brief",
    "task-e brief",
    "task-g plan",
    "task-h plan",
  ]);
  expect(check(printed, "task-g plan")).toEqual({
    name: "task-g plan",
    state: "ok",
    detail: `${plan} is readable`,
    fix: null,
  });
  expect(check(printed, "task-h plan")).toMatchObject({
    state: "warn",
    detail: `${lost} is not a readable file`,
  });
  expect(check(printed, "task-h plan").fix).toContain("agent-task add task-h");
  expect(check(printed, "task-a repository")).toMatchObject({ state: "ok", fix: null });
  expect(check(printed, "task-a brief")).toEqual({
    name: "task-a brief",
    state: "ok",
    detail: `${readable} is readable`,
    fix: null,
  });
  expect(check(printed, "task-b repository")).toMatchObject({ state: "ok", fix: null });
  for (const [name, state, act] of [
    ["task-c repository", "fail", "done"],
    ["task-d repository", "warn", "done"],
    ["task-e brief", "warn", "stop"],
    ["task-f repository", "fail", "done"],
  ] as const) {
    const one = check(printed, name);
    const task = name.split(" ")[0];
    expect([name, one.state]).toEqual([name, state]);
    expect(one.fix).toContain(`agent-task ${act} ${task}`);
  }
  expect(check(printed, "task-d repository").detail).toContain(outer);
  expect(check(printed, "task-e repository").state).toBe("ok");
  expect(printed.failing).toBe(2);
});

test("AC-36 doctor leads with the count in each state, and by default prints each check without its fix and the fix of each that warns or fails apart", () => {
  const w = world();
  const bin = binWith(w, ["bash", "git"], true);
  const ran = run(w, w.root, ["doctor"], { env: { PATH: bin } });
  expect([ran.exitCode, ran.stderr]).toEqual([0, ""]);
  const shown = decode(ran.stdout);
  expect(shown).toMatchObject({ command: "doctor", ok: true });
  const shownResult = shownAt(shown, "result");
  expect(Object.keys(shownResult)).toEqual(["count", "checks", "fixes"]);
  expect(shownResult.count).toEqual({ ok: 4, warn: 1, fail: 0 });
  expect(shownListAt(shownResult, "checks").map((one) => Object.keys(one))).toEqual(
    Array(5).fill(["name", "state", "detail"]),
  );
  expect(ran.stdout).toContain("\n  checks[5]{name,state,detail}:\n");
  expect(shownResult.fixes).toEqual([
    {
      name: "jq",
      fix: "install jq on the PATH Claude Code starts with, then run agent-task doctor under that PATH",
    },
  ]);
  expect(doctor(w, bin, 0).checks).toContainEqual(
    expect.objectContaining({ name: "jq", fix: expect.any(String) }),
  );
});
