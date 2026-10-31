import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { brief, refusal, removeScratchDirs, repo, result, run, shownAt, world } from "./harness";

afterEach(removeScratchDirs);

const REASON = "a flaw in the workflow";

const OWNER_RESUMES =
  "make no change: state your report and stop; only the owner lifts the halt, with agent-task resume";

test("AC-38 halt stops add, start and wait until resume lifts it, halted and list report it, and a record that cannot be read counts as raised", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(dir);
  const store = join(w.root, "data", "agent-task");
  const haltFile = join(store, "halt.json");
  expect(result(run(w, w.root, ["halted"]))).toEqual({ halt: { state: "none" } });
  result(run(w, w.root, ["add", "task-a", "--repo", dir, "--goal", "do a"]));
  const before = readdirSync(store).toSorted();
  const raised = shownAt(result(run(w, w.root, ["halt", REASON])), "halt");
  expect(raised).toEqual({ state: "raised", reason: REASON, raised: expect.any(String) });
  expect(readdirSync(store).toSorted()).toEqual([...before, "halt.json"].toSorted());
  expect(result(run(w, w.root, ["halt", "another"]))).toEqual({ halt: raised });
  expect(refusal(run(w, w.root, ["halted"]))).toEqual({
    kind: "refusal",
    code: "halted",
    message: `all agent work on this machine is halted, since ${String(raised.raised)}: ${REASON}`,
    meta: raised,
    resolve: OWNER_RESUMES,
  });
  const listed = result(run(w, w.root, ["list"]));
  expect(Object.keys(listed)).toEqual(["counts", "halt", "tasks", "ready", "waiting"]);
  expect(listed.halt).toEqual(raised);
  for (const args of [
    ["add", "task-b", "--repo", dir, "--goal", "do b"],
    ["start", "task-a", "--repo", dir, "--brief", file],
    ["start", "task-c", "--repo", dir, "--brief", file],
    ["wait", "task-a", "--until", "exit 0"],
  ])
    expect(refusal(run(w, w.root, args))).toMatchObject({
      code: "halted",
      meta: raised,
      resolve: OWNER_RESUMES,
    });
  expect(result(run(w, w.root, ["list"]))).toEqual(listed);
  expect(result(run(w, w.root, ["resume"]))).toEqual({ halt: raised });
  expect(result(run(w, w.root, ["halted"]))).toEqual({ halt: { state: "none" } });
  expect(result(run(w, w.root, ["start", "task-a", "--repo", dir, "--brief", file]))).toMatchObject({
    name: "task-a",
    state: "running",
  });
  expect(result(run(w, w.root, ["resume"]))).toEqual({ halt: { state: "none" } });
  for (const args of [["halt"], ["halt", " "], ["halt", "one", "two"]]) {
    const misused = run(w, w.root, args);
    expect([misused.exitCode, misused.stdout]).toEqual([2, ""]);
    expect(decode(misused.stderr)).toMatchObject({ error: { kind: "usage", code: "bad_arguments" } });
  }
  writeFileSync(haltFile, "half a reco");
  const unreadable = { state: "unreadable", path: haltFile, detail: expect.any(String) };
  expect(refusal(run(w, w.root, ["halted"]))).toMatchObject({
    code: "halted",
    message: expect.stringContaining(haltFile),
    meta: unreadable,
    resolve: OWNER_RESUMES,
  });
  expect(result(run(w, w.root, ["list"])).halt).toEqual(unreadable);
  expect(refusal(run(w, w.root, ["start", "task-d", "--repo", dir, "--brief", file]))).toMatchObject({
    code: "halted",
  });
  expect(result(run(w, w.root, ["resume"]))).toEqual({ halt: unreadable });
  expect(result(run(w, w.root, ["halted"]))).toEqual({ halt: { state: "none" } });
  mkdirSync(haltFile);
  expect(refusal(run(w, w.root, ["halted"]))).toMatchObject({
    code: "halted",
    meta: { state: "unreadable" },
  });
  expect(refusal(run(w, w.root, ["resume"]))).toMatchObject({
    code: "halt_unremovable",
    meta: { path: haltFile },
  });
  expect(refusal(run(w, w.root, ["halted"]))).toMatchObject({ code: "halted" });
});
