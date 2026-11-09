import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { decode } from "@toon-format/toon";
import {
  brief,
  limitsAt,
  listing,
  refusal,
  removeScratchDirs,
  repo,
  result,
  run,
  setLimits,
  world,
} from "./harness";

afterEach(removeScratchDirs);

const RETRY = "once the machine is less busy; only the owner changes this machine's limits, in";

test("AC-50 start is refused machine_busy while the load per core is above its limit or the available memory below its own, each limit the machine's own with its default, and recording nothing", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(dir);
  const startA = ["start", "task-a", "--repo", dir, "--brief", file];
  result(run(w, w.root, ["add", "task-b", "--repo", dir, "--goal", "do b"]));
  const before = listing(run(w, w.root, ["list"]));
  setLimits(w, { maxLoadPerCore: 0 });
  const loaded = refusal(run(w, w.root, startA));
  expect(loaded).toMatchObject({
    kind: "refusal",
    code: "machine_busy",
    message: expect.stringMatching(
      /^this machine is too busy to start another task: the 1-minute load average is [\d.]+ on \d+ cores, [\d.]+ per core, above the limit of 0/,
    ),
    meta: {
      name: "task-a",
      over: expect.arrayContaining(["load"]),
      load: { cores: cpus().length, limit: 0 },
      memory: { limit: 0.15 },
      path: limitsAt(w),
    },
    resolve: expect.stringContaining(`${RETRY} ${limitsAt(w)}`),
  });
  setLimits(w, { minAvailableMemory: 1 });
  expect(refusal(run(w, w.root, startA))).toMatchObject({
    code: "machine_busy",
    message: expect.stringMatching(/\d+% of memory is available, below the limit of 100%$/),
    meta: { over: expect.arrayContaining(["memory"]), load: { limit: 0.7 }, memory: { limit: 1 } },
  });
  expect(listing(run(w, w.root, ["list"]))).toEqual(before);
  result(run(w, w.root, ["add", "task-c", "--repo", dir, "--goal", "do c"]));
  result(run(w, w.root, ["priority", "task-c", "high"]));
  result(run(w, w.root, ["done", "task-c"]));
  setLimits(w, { maxLoadPerCore: 1_000_000, minAvailableMemory: 0 });
  expect(result(run(w, w.root, startA))).toMatchObject({ name: "task-a", state: "running" });
});

test("AC-51 start refuses limits_unreadable for a limits file that is not JSON of the two limits, and has no flag past the check", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(dir);
  const startA = ["start", "task-a", "--repo", dir, "--brief", file];
  for (const text of ["not json", '{"maxLoad": 1}', '{"minAvailableMemory": 2}']) {
    writeFileSync(limitsAt(w), text);
    expect(refusal(run(w, w.root, startA))).toMatchObject({
      code: "limits_unreadable",
      meta: { path: limitsAt(w) },
    });
  }
  setLimits(w, { maxLoadPerCore: 0, minAvailableMemory: 1 });
  for (const flag of ["--force", "--no-limits"]) {
    const forced = run(w, w.root, [...startA, flag]);
    expect([forced.exitCode, forced.stdout]).toEqual([2, ""]);
    expect(decode(forced.stderr)).toMatchObject({ error: { kind: "usage", code: "bad_arguments" } });
  }
  expect(result(run(w, w.root, ["list"]))).toMatchObject({ counts: { running: 0 } });
});
