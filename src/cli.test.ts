import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { removeScratchDirs, scratchDir } from "./repo.test-support";

const CLI = resolve(import.meta.dir, "cli.ts");

const dataHome = scratchDir();

afterAll(removeScratchDirs);

function cli(...args: string[]) {
  return cliWith({}, ...args);
}

function cliWith(env: Readonly<Record<string, string>>, ...args: string[]) {
  const run = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, XDG_DATA_HOME: dataHome, ...env },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("the cli", () => {
  test("prints the listing as one JSON line naming the program and each command", () => {
    const run = cli();
    expect([run.status, run.stderr]).toEqual([0, ""]);
    expect(run.stdout.split("\n")).toHaveLength(2);
    const listed = JSON.parse(run.stdout);
    expect(listed).toMatchObject({ command: "agent-task", ok: true });
    expect(listed.result.commands.map(({ name }: { name: string }) => name)).toEqual([
      "add",
      "start",
      "wait",
      "review",
      "list",
      "stop",
      "done",
      "doctor",
    ]);
  });

  test("prints a result as one JSON line naming the command, exit 0", () => {
    expect(cli("list")).toEqual({
      status: 0,
      stdout: '{"command":"list","ok":true,"result":{"tasks":[],"ready":[],"waiting":[]}}\n',
      stderr: "",
    });
  });

  test("prints doctor's report as a result on stdout, exit 1 when a check fails", () => {
    const run = cliWith({ PATH: "" }, "doctor");
    expect([run.status, run.stderr]).toEqual([1, ""]);
    expect(run.stdout.split("\n")).toHaveLength(2);
    expect(JSON.parse(run.stdout)).toMatchObject({ command: "doctor", ok: true, result: { failing: 1 } });
  });

  test("exits 1 with one JSON line on stderr for a refusal", () => {
    const run = cli("stop", "no-such-task");
    expect([run.status, run.stdout]).toEqual([1, ""]);
    expect(JSON.parse(run.stderr)).toMatchObject({
      command: "stop",
      ok: false,
      error: { kind: "refusal", code: "unknown_task", meta: { name: "no-such-task", act: "stop" } },
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
        meta: {
          name: "frobnicate",
          usage: "agent-task add|start|wait|review|list|stop|done|doctor|--version",
        },
        resolve: "agent-task add|start|wait|review|list|stop|done|doctor|--version",
      },
    });
  });

  test("refuses a command's misused arguments as a usage error naming its usage", () => {
    for (const args of [
      ["add", "a", "--repo", "."],
      ["add", "a", "--repo", ".", "--goal", "g", "--after", "a"],
      ["add", "a", "--repo", ".", "--goal", "g", "--priority", "top"],
      ["add", "a", "--repo", ".", "--goal", "g", "--after", ""],
      ["add", "a", "--repo", ".", "--goal", "g", "--plan"],
      ["wait"],
      ["wait", "a", "--after", "a"],
      ["wait", "a", "--waits", " "],
      ["start", "a"],
      ["start", "a", "b", "--repo", ".", "--brief", "x"],
      ["list", "extra"],
      ["doctor", "extra"],
      ["start", "a", "--repo", ".", "--brief", "x", "--session", " "],
      ["review"],
      ["review", "a", "b"],
      ["stop"],
      ["stop", "a", "--force"],
      ["done", "a", "b"],
      ["done", "a", "--commit", "abc"],
    ]) {
      const run = cli(...args);
      expect([args, run.status, JSON.parse(run.stderr).error.code]).toEqual([args, 2, "bad_arguments"]);
    }
  });
});
