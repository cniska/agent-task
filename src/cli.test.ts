import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { decode } from "@toon-format/toon";
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
  test("prints the listing as TOON naming the program, each command and each flag for --help", () => {
    const run = cli("--help");
    expect([run.status, run.stderr]).toEqual([0, ""]);
    expect(decode(run.stdout)).toMatchObject({
      command: "agent-task",
      ok: true,
      result: {
        commands: ["add", "start", "wait", "review", "list", "stop", "done", "doctor"].map((name) => ({
          name,
        })),
        flags: [{ name: "--help" }, { name: "--version" }],
      },
    });
  });

  test("runs list for no command", () => {
    expect(cli()).toEqual(cli("list"));
  });

  test("prints a result as TOON naming the command, exit 0", () => {
    expect(cli("list")).toEqual({
      status: 0,
      stdout:
        "command: list\nok: true\nresult:\n  counts:\n    running: 0\n    review: 0\n    ready: 0\n    waiting: 0\n  tasks: []\n  ready: []\n  waiting: []\n",
      stderr: "",
    });
  });

  test("prints the started tasks alone for list --started", () => {
    expect(cli("list", "--started")).toEqual({
      status: 0,
      stdout: "command: list\nok: true\nresult:\n  counts:\n    running: 0\n    review: 0\n  tasks: []\n",
      stderr: "",
    });
  });

  test("prints doctor's report as a result on stdout, exit 1 when a check fails", () => {
    const run = cliWith({ PATH: "" }, "doctor");
    expect([run.status, run.stderr]).toEqual([1, ""]);
    expect(decode(run.stdout)).toMatchObject({
      command: "doctor",
      ok: true,
      result: { counts: { fail: 1 } },
    });
  });

  test("exits 1 with the error as TOON on stderr for a refusal", () => {
    const run = cli("stop", "no-such-task");
    expect([run.status, run.stdout]).toEqual([1, ""]);
    expect(decode(run.stderr)).toMatchObject({
      command: "stop",
      ok: false,
      error: { kind: "refusal", code: "unknown_task", meta: { name: "no-such-task", act: "stop" } },
    });
  });

  test("exits 2 with the error as TOON on stderr for a usage error", () => {
    const run = cli("frobnicate");
    expect([run.status, run.stdout]).toEqual([2, ""]);
    expect(decode(run.stderr)).toEqual({
      command: "agent-task",
      ok: false,
      error: {
        kind: "usage",
        code: "unknown_command",
        message: "frobnicate is not an agent-task command; agent-task --help lists them",
        meta: {
          name: "frobnicate",
          usage: "agent-task add|start|wait|review|list|stop|done|doctor|--help|--version",
        },
        resolve: "agent-task add|start|wait|review|list|stop|done|doctor|--help|--version",
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
      ["add", "a", "--repo", ".", "--goal", "g", "--until", ""],
      ["wait"],
      ["wait", "a", "--after", "a"],
      ["wait", "a", "--until", " "],
      ["wait", "a", "--waits", " "],
      ["start", "a"],
      ["start", "a", "b", "--repo", ".", "--brief", "x"],
      ["list", "extra"],
      ["list", "--started", "extra"],
      ["list", "--queued"],
      ["list", "--brief-under", "."],
      ["list", "--started", "--brief-under", " "],
      ["doctor", "extra"],
      ["doctor", "--full", "extra"],
      ["list", "--full=yes"],
      ["start", "a", "--repo", ".", "--brief", "x", "--session", " "],
      ["review"],
      ["review", "a", "b"],
      ["stop"],
      ["stop", "a", "--force"],
      ["done", "a", "b"],
      ["done", "a", "--commit", "abc"],
    ]) {
      const run = cli(...args);
      expect([args, run.status, decode(run.stderr)]).toMatchObject([
        args,
        2,
        { error: { code: "bad_arguments" } },
      ]);
    }
  });
});
