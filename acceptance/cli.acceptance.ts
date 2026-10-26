import { afterEach, expect, test } from "bun:test";
import { decode } from "@toon-format/toon";
import { version } from "../package.json";
import { removeScratchDirs, run, world } from "./harness";

afterEach(removeScratchDirs);

test("AC-18 --version prints the version alone, and refuses an argument as a usage error", () => {
  const w = world();
  expect(run(w, w.root, ["--version"])).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
  const extra = run(w, w.root, ["--version", "now"]);
  expect([extra.exitCode, extra.stdout]).toEqual([2, ""]);
  expect(decode(extra.stderr)).toMatchObject({
    command: "agent-task",
    ok: false,
    error: { kind: "usage", code: "wrong_arity", resolve: "agent-task --version" },
  });
});

test("AC-19 no command and --help list the commands and the version flag", () => {
  const w = world();
  const bare = run(w, w.root, []);
  expect([bare.exitCode, bare.stderr]).toEqual([0, ""]);
  expect(decode(bare.stdout)).toEqual({
    command: "agent-task",
    ok: true,
    result: {
      commands: ["add", "start", "wait", "review", "list", "stop", "done", "doctor"].map((name) => ({
        name,
        usage: expect.stringMatching(new RegExp(`^agent-task ${name}`)),
        summary: expect.any(String),
      })),
      flags: [
        { name: "--version", usage: "agent-task --version", summary: "print the version alone on one line" },
      ],
    },
  });
  expect(run(w, w.root, ["--help"]).stdout).toBe(bare.stdout);
});

test("AC-20 an unknown command and a misused one are usage errors on stderr, exit 2, and a refusal exits 1", () => {
  const w = world();
  const unknown = run(w, w.root, ["frobnicate"]);
  expect([unknown.exitCode, unknown.stdout]).toEqual([2, ""]);
  expect(decode(unknown.stderr)).toMatchObject({
    command: "agent-task",
    ok: false,
    error: { kind: "usage", code: "unknown_command", meta: { name: "frobnicate" } },
  });
  const misused = run(w, w.root, ["start", "task-a", "--repo", w.root]);
  expect([misused.exitCode, misused.stdout]).toEqual([2, ""]);
  expect(decode(misused.stderr)).toMatchObject({
    command: "start",
    ok: false,
    error: {
      kind: "usage",
      code: "bad_arguments",
      resolve: "agent-task start <name> --repo <path> --brief <file> [--session <id>]",
    },
  });
  const refused = run(w, w.root, ["stop", "nobody"]);
  expect([refused.exitCode, refused.stdout]).toEqual([1, ""]);
  expect(decode(refused.stderr)).toMatchObject({
    command: "stop",
    ok: false,
    error: { kind: "refusal", code: "unknown_task" },
  });
});
