import { describe, expect, test } from "bun:test";
import { doctorView, listingView, startedListingView } from "./cli-views";
import type { Halt } from "./halt";
import { named, projectNamed } from "./repo.test-support";
import type { Checked, Listed } from "./tasks";

const ADDED = {
  project: null,
  repo: "/work/repo",
  goal: null,
  plan: null,
  priority: null,
  waits: null,
  added: "2026-10-16T10:00:00.000Z",
};

const BRIEFED = {
  ...ADDED,
  brief: "/work/briefs/a.md",
  briefSha: "abc",
  session: null,
  started: "2026-10-16T10:00:00.000Z",
};

const RUNNING: Listed = {
  ...BRIEFED,
  name: named("task-a"),
  project: projectNamed("site"),
  state: "running",
  briefChanged: true,
};

const IN_REVIEW: Listed = {
  ...BRIEFED,
  name: named("task-b"),
  state: "review",
  reviewed: "2026-10-16T11:00:00.000Z",
  briefChanged: false,
};

const READY: Checked = {
  ...ADDED,
  name: named("task-c"),
  goal: "do c",
  state: "queued",
  after: [],
  until: null,
  untilState: null,
};

const WAITING: Checked = { ...READY, name: named("task-d"), after: [named("task-c")], waits: "the owner" };

const HALT: Halt = { state: "raised", reason: "a flaw in the workflow", raised: "2026-10-16T12:00:00.000Z" };

const LISTING = { tasks: [RUNNING, IN_REVIEW], halt: HALT, ready: [READY], waiting: [WAITING] };

describe("the list views", () => {
  test("lead with the counts in each group, then print the fields an agent acts on by default", () => {
    const view = listingView(LISTING, "default");
    expect(Object.keys(view)).toEqual(["counts", "halt", "tasks", "ready", "waiting"]);
    expect(view).toEqual({
      counts: { running: 1, review: 1, ready: 1, waiting: 1 },
      halt: { state: "raised", reason: "a flaw in the workflow", raised: "2026-10-16T12:00:00.000Z" },
      tasks: [
        {
          name: RUNNING.name,
          project: RUNNING.project,
          state: "running",
          brief: "/work/briefs/a.md",
          briefChanged: true,
        },
        {
          name: IN_REVIEW.name,
          project: null,
          state: "review",
          brief: "/work/briefs/a.md",
          briefChanged: false,
        },
      ],
      ready: [{ name: READY.name, project: null, repo: "/work/repo" }],
      waiting: [{ name: WAITING.name, project: null, repo: "/work/repo" }],
    });
  });

  test("print every field with --full, a running task's review time as null", () => {
    const view = listingView(LISTING, "full");
    expect(view.tasks).toEqual([
      { ...RUNNING, reviewed: null },
      { ...IN_REVIEW, reviewed: "2026-10-16T11:00:00.000Z" },
    ]);
    expect(view.tasks.map((task) => Object.keys(task))).toEqual([
      [
        "name",
        "project",
        "state",
        "repo",
        "goal",
        "plan",
        "priority",
        "waits",
        "added",
        "brief",
        "briefSha",
        "session",
        "started",
        "reviewed",
        "briefChanged",
      ],
      expect.any(Array),
    ]);
    expect([...view.ready, ...view.waiting]).toEqual([READY, WAITING]);
  });

  test("count the running and in-review tasks alone for the started listing", () => {
    expect(startedListingView({ tasks: [IN_REVIEW] }, "default")).toEqual({
      counts: { running: 0, review: 1 },
      tasks: [
        {
          name: IN_REVIEW.name,
          project: null,
          state: "review",
          brief: "/work/briefs/a.md",
          briefChanged: false,
        },
      ],
    });
  });
});

describe("the doctor view", () => {
  const checks = [
    { name: "store", state: "ok", detail: "a store", fix: null },
    { name: "jq", state: "warn", detail: "not found", fix: "install jq" },
    { name: "git", state: "fail", detail: "not found", fix: "install git" },
  ] as const;

  test("leads with the counts in each state and prints the checks that warn or fail by default", () => {
    expect(doctorView(checks, "default")).toEqual({
      counts: { ok: 1, warn: 1, fail: 1 },
      checks: [checks[1], checks[2]],
    });
  });

  test("prints an empty checks table by default when every check passes", () => {
    expect(doctorView([checks[0]], "default")).toEqual({
      counts: { ok: 1, warn: 0, fail: 0 },
      checks: [],
    });
  });

  test("prints every check with --full", () => {
    expect(doctorView(checks, "full")).toEqual({ counts: { ok: 1, warn: 1, fail: 1 }, checks });
  });
});
