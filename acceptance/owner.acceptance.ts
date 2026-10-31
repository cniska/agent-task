import { afterEach, expect, test } from "bun:test";
import { decode } from "@toon-format/toon";
import {
  brief,
  type Ran,
  refusal,
  removeScratchDirs,
  repo,
  result,
  run,
  shownListAt,
  type World,
  world,
} from "./harness";

afterEach(removeScratchDirs);

const DOMAIN = "Which domain does the site use: example.com or example.org?";

const OWNER_ACTS =
  "agent-task done ask-a once the owner has answered or done it; agent-task ask ask-a <text> [--project <id>] [--priority urgent|high|medium|low] or agent-task map ask-a --project <id> changes it";

function ask(w: World, name: string, text: string, ...flags: string[]): Ran {
  return run(w, w.root, ["ask", name, text, ...flags]);
}

function project(w: World, id: string, dir: string): void {
  result(run(w, w.root, ["project", "add", id, "--name", `The ${id}`, "--repo", dir, "--dir", dir]));
}

function ownerOf(w: World, ...flags: string[]): readonly unknown[] {
  return shownListAt(result(run(w, w.root, ["list", ...flags])), "owner").map(({ name }) => name);
}

test("AC-46 ask records an owner item with its text, project and priority and replaces them on its name, refuses a task's name, and add, start, wait, review and stop refuse it naming done, ask and map", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(dir);
  project(w, "site", dir);
  const asked = result(ask(w, "ask-a", DOMAIN, "--project", "site", "--priority", "high"));
  expect(asked).toEqual({
    name: "ask-a",
    state: "owner",
    project: "site",
    priority: "high",
    ask: DOMAIN,
    added: expect.any(String),
  });
  expect(result(ask(w, "ask-a", "Rotate the deploy key"))).toEqual({
    ...asked,
    project: null,
    priority: null,
    ask: "Rotate the deploy key",
  });
  result(run(w, w.root, ["add", "task-a", "--repo", dir, "--goal", "do a"]));
  expect(refusal(ask(w, "task-a", DOMAIN))).toMatchObject({
    code: "name_taken",
    meta: { name: "task-a", state: "queued" },
  });
  expect(refusal(ask(w, "ask-b", DOMAIN, "--project", "nowhere"))).toMatchObject({ code: "unknown_project" });
  const blank = ask(w, "ask-b", " ");
  expect([blank.exitCode, decode(blank.stderr)]).toMatchObject([2, { error: { code: "bad_arguments" } }]);
  for (const [act, ...rest] of [
    ["add", "--repo", dir, "--goal", "do it"],
    ["start", "--repo", dir, "--brief", file],
    ["wait", "--waits", "the owner"],
    ["review"],
    ["stop"],
  ] as const)
    expect(refusal(run(w, w.root, [act, "ask-a", ...rest]))).toEqual({
      kind: "refusal",
      code: "waits_on_owner",
      message: `agent-task ${act} does not apply to ask-a, which waits on the owner: Rotate the deploy key`,
      meta: { name: "ask-a", act, ask: "Rotate the deploy key" },
      resolve: OWNER_ACTS,
    });
  expect(result(run(w, w.root, ["list", "--full"])).owner).toEqual([
    { ...asked, project: null, priority: null, ask: "Rotate the deploy key" },
  ]);
  result(run(w, w.root, ["halt", "a flaw in the workflow"]));
  expect(refusal(ask(w, "ask-c", DOMAIN))).toMatchObject({ code: "halted" });
  result(run(w, w.root, ["resume"]));
  expect(ownerOf(w)).toEqual(["ask-a"]);
});

test("AC-47 map maps an owner item, a task waiting after one is blocked until done closes it, and list prints the owner items apart from ready and waiting by priority, time and name", () => {
  const w = world();
  const dir = repo(w);
  project(w, "site", dir);
  result(ask(w, "ask-low", "Pick a name", "--priority", "low"));
  result(ask(w, "ask-a", DOMAIN));
  result(ask(w, "ask-urgent", "Renew the certificate", "--priority", "urgent"));
  expect(result(run(w, w.root, ["map", "ask-a", "--project", "site"]))).toMatchObject({
    name: "ask-a",
    state: "owner",
    project: "site",
  });
  result(run(w, w.root, ["add", "task-a", "--repo", dir, "--goal", "do a", "--after", "ask-a"]));
  const listed = result(run(w, w.root, ["list"]));
  expect(listed.counts).toEqual({ running: 0, review: 0, ready: 0, waiting: 1, owner: 3 });
  expect(listed.owner).toEqual([
    { name: "ask-urgent", project: null, ask: "Renew the certificate" },
    { name: "ask-low", project: null, ask: "Pick a name" },
    { name: "ask-a", project: "site", ask: DOMAIN },
  ]);
  const file = brief(dir);
  expect(refusal(run(w, w.root, ["start", "task-a", "--repo", dir, "--brief", file]))).toMatchObject({
    code: "blocked",
    meta: { name: "task-a", after: ["ask-a"] },
  });
  expect(result(run(w, w.root, ["done", "ask-a"]))).toMatchObject({ name: "ask-a", state: "owner" });
  expect(result(run(w, w.root, ["start", "task-a", "--repo", dir, "--brief", file]))).toMatchObject({
    state: "running",
  });
  expect(ownerOf(w)).toEqual(["ask-urgent", "ask-low"]);
});

test("AC-48 with two projects' tasks and owner items, list --project prints each project's own, and list --owner groups the owner items by project, the unmapped last, refusing when none are listed", () => {
  const w = world();
  const dir = repo(w);
  const empty = run(w, w.root, ["list", "--owner"]);
  expect([empty.exitCode, empty.stdout]).toEqual([1, ""]);
  expect(decode(empty.stderr)).toMatchObject({ error: { code: "no_owner_items", meta: { project: null } } });
  for (const id of ["site", "app"]) {
    project(w, id, dir);
    result(run(w, w.root, ["add", `task-${id}`, "--repo", dir, "--goal", "go", "--project", id]));
    result(ask(w, `ask-${id}`, `Answer for ${id}`, "--project", id));
  }
  result(ask(w, "ask-none", "Rotate the deploy key"));
  for (const id of ["site", "app"]) {
    const own = result(run(w, w.root, ["list", "--project", id]));
    expect(shownListAt(own, "ready").map(({ name }) => name)).toEqual([`task-${id}`]);
    expect(shownListAt(own, "owner").map(({ name }) => name)).toEqual([`ask-${id}`]);
  }
  const grouped = run(w, w.root, ["list", "--owner"]);
  expect(result(grouped)).toEqual({
    counts: { owner: 3 },
    owner: [
      {
        project: "app",
        name: "The app",
        items: [{ name: "ask-app", project: "app", ask: "Answer for app" }],
      },
      {
        project: "site",
        name: "The site",
        items: [{ name: "ask-site", project: "site", ask: "Answer for site" }],
      },
      {
        project: null,
        name: null,
        items: [{ name: "ask-none", project: null, ask: "Rotate the deploy key" }],
      },
    ],
  });
  expect(result(run(w, w.root, ["list", "--owner", "--project", "site"]))).toEqual({
    counts: { owner: 1 },
    owner: [
      {
        project: "site",
        name: "The site",
        items: [{ name: "ask-site", project: "site", ask: "Answer for site" }],
      },
    ],
  });
  result(run(w, w.root, ["done", "ask-site"]));
  expect(refusal(run(w, w.root, ["list", "--owner", "--project", "site"]))).toMatchObject({
    code: "no_owner_items",
    meta: { project: "site" },
    resolve: "agent-task ask <name> <text> [--project <id>] [--priority urgent|high|medium|low]",
  });
  const both = run(w, w.root, ["list", "--owner", "--started"]);
  expect([both.exitCode, decode(both.stderr)]).toMatchObject([2, { error: { code: "bad_arguments" } }]);
});
