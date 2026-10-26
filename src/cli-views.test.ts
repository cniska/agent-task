import { describe, expect, test } from "bun:test";
import { doctorView, listingView, startedListingView } from "./cli-views";
import { named } from "./repo.test-support";
import type { Checked, Listed } from "./tasks";

const ADDED = {
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

const RUNNING: Listed = { ...BRIEFED, name: named("task-a"), state: "running", briefChanged: true };

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

const LISTING = { tasks: [RUNNING, IN_REVIEW], ready: [READY], waiting: [WAITING] };

describe("the list views", () => {
  test("lead with the count in each group, then print the fields an agent acts on by default", () => {
    const view = listingView(LISTING, "default");
    expect(Object.keys(view)).toEqual(["count", "tasks", "ready", "waiting"]);
    expect<unknown>(view).toEqual({
      count: { running: 1, review: 1, ready: 1, waiting: 1 },
      tasks: [
        { name: "task-a", state: "running", brief: "/work/briefs/a.md", briefChanged: true },
        { name: "task-b", state: "review", brief: "/work/briefs/a.md", briefChanged: false },
      ],
      ready: [{ name: "task-c", repo: "/work/repo" }],
      waiting: [{ name: "task-d", repo: "/work/repo" }],
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
    expect<unknown>(startedListingView({ tasks: [IN_REVIEW] }, "default")).toEqual({
      count: { running: 0, review: 1 },
      tasks: [{ name: "task-b", state: "review", brief: "/work/briefs/a.md", briefChanged: false }],
    });
  });
});

describe("the doctor view", () => {
  const checks = [
    { name: "store", state: "ok", detail: "a store", fix: null },
    { name: "jq", state: "warn", detail: "not found", fix: "install jq" },
    { name: "git", state: "fail", detail: "not found", fix: "install git" },
  ] as const;

  test("leads with the count in each state and puts each fix apart from the checks by default", () => {
    expect<unknown>(doctorView(checks, "default")).toEqual({
      count: { ok: 1, warn: 1, fail: 1 },
      checks: checks.map(({ name, state, detail }) => ({ name, state, detail })),
      fixes: [
        { name: "jq", fix: "install jq" },
        { name: "git", fix: "install git" },
      ],
    });
  });

  test("prints every check with its fix with --full", () => {
    expect<unknown>(doctorView(checks, "full")).toEqual({ count: { ok: 1, warn: 1, fail: 1 }, checks });
  });
});
