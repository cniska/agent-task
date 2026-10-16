import { afterEach, expect, test } from "bun:test";
import { version } from "../package.json";
import { removeScratch, run, world } from "./harness";

afterEach(removeScratch);

test("AC-1 --version prints the version alone, and refuses an argument as a usage error", () => {
  const w = world();
  expect(run(w, w.root, ["--version"])).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
  const extra = run(w, w.root, ["--version", "now"]);
  expect([extra.exitCode, extra.stdout]).toEqual([2, ""]);
  expect(JSON.parse(extra.stderr)).toMatchObject({
    command: "agent-task",
    ok: false,
    error: { kind: "usage", code: "wrong_arity", resolve: "agent-task --version" },
  });
});

test("AC-2 no command and --help list the commands and the version flag as one JSON line", () => {
  const w = world();
  const bare = run(w, w.root, []);
  expect([bare.exitCode, bare.stderr]).toEqual([0, ""]);
  const listed = JSON.parse(bare.stdout);
  expect(listed).toMatchObject({ command: "agent-task", ok: true });
  expect(listed.result.flags).toEqual([
    { name: "--version", usage: "agent-task --version", summary: "print the version alone on one line" },
  ]);
  expect(run(w, w.root, ["--help"]).stdout).toBe(bare.stdout);
});

test("AC-3 an unknown command is a usage error on stderr naming it, exit 2", () => {
  const w = world();
  const unknown = run(w, w.root, ["frobnicate"]);
  expect([unknown.exitCode, unknown.stdout]).toEqual([2, ""]);
  expect(JSON.parse(unknown.stderr)).toMatchObject({
    command: "agent-task",
    ok: false,
    error: { kind: "usage", code: "unknown_command", meta: { name: "frobnicate" } },
  });
});
