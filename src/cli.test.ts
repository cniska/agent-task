import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dir, "cli.ts");

function cli(...args: string[]) {
  const run = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("the cli", () => {
  test("prints the listing as one JSON line naming the program", () => {
    const run = cli();
    expect([run.status, run.stderr]).toEqual([0, ""]);
    expect(run.stdout.endsWith("}\n")).toBe(true);
    expect(run.stdout.split("\n")).toHaveLength(2);
    expect(JSON.parse(run.stdout)).toMatchObject({
      command: "agent-task",
      ok: true,
      result: { commands: [] },
    });
  });

  test("exits 2 with one JSON line on stderr for a usage error", () => {
    const run = cli("frobnicate");
    expect([run.status, run.stdout]).toEqual([2, ""]);
    expect(JSON.parse(run.stderr)).toEqual({
      command: "agent-task",
      ok: false,
      error: {
        kind: "usage",
        code: "unknown_command",
        message: "frobnicate is not an agent-task command; agent-task with no command lists them",
        meta: { name: "frobnicate", usage: "agent-task --version" },
        resolve: "agent-task --version",
      },
    });
  });
});
