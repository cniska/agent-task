import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import {
  binWith,
  brief,
  listing,
  type Ran,
  refusal,
  removeScratchDirs,
  repo,
  result,
  run,
  type World,
  world,
} from "./harness";

afterEach(removeScratchDirs);

const PLUGIN = join(import.meta.dir, "..", "plugin");

const SHELL = "/bin/sh";

const ON_PATH = ["bash", "git", "jq"];

type Hook = { readonly matcher: string | null; readonly command: string };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function registeredHooks(): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) throw new Error("hooks.json holds a hooks object");
  return parsed.hooks;
}

function hookOf(event: string): Hook {
  const handlers = registeredHooks()[event];
  if (!Array.isArray(handlers) || handlers.length !== 1)
    throw new Error(`hooks.json has one ${event} handler`);
  const [handler] = handlers;
  if (!isRecord(handler) || !Array.isArray(handler.hooks) || handler.hooks.length !== 1)
    throw new Error("a handler holds one hook");
  const matcher = handler.matcher ?? null;
  if (matcher !== null && typeof matcher !== "string") throw new Error("a matcher is a string");
  const [hook] = handler.hooks;
  if (!isRecord(hook) || hook.type !== "command" || typeof hook.command !== "string")
    throw new Error("a hook is a command");
  return { matcher, command: hook.command };
}

function pluginName(): unknown {
  const parsed: unknown = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
  return isRecord(parsed) ? parsed.name : null;
}

function hook(w: World, bin: string, event: string, cwd: string, input: unknown): Ran {
  const ran = spawnSync(SHELL, ["-c", hookOf(event).command], {
    cwd,
    encoding: "utf8",
    input: JSON.stringify(input),
    env: { ...w.env, PATH: bin, CLAUDE_PLUGIN_ROOT: PLUGIN },
  });
  return { exitCode: ran.status ?? -1, stdout: ran.stdout, stderr: ran.stderr };
}

function sessionStart(w: World, bin: string, cwd: string, from = cwd): Ran {
  return hook(w, bin, "SessionStart", from, { hook_event_name: "SessionStart", source: "startup", cwd });
}

function context(ran: Ran): string {
  expect([ran.exitCode, ran.stderr]).toEqual([0, ""]);
  const printed: unknown = JSON.parse(ran.stdout);
  if (!isRecord(printed) || !isRecord(printed.hookSpecificOutput)) throw new Error("no hookSpecificOutput");
  const { hookEventName, additionalContext } = printed.hookSpecificOutput;
  expect(hookEventName).toBe("SessionStart");
  if (typeof additionalContext !== "string") throw new Error("no context");
  return additionalContext;
}

const SILENT = { exitCode: 0, stdout: "", stderr: "" };

test("AC-24 the session hook puts the running and in-review tasks in context where the working directory holds one of their briefs, and prints nothing elsewhere", () => {
  const w = world();
  const bin = binWith(w, ON_PATH, true);
  const dir = repo(w);
  const briefs = join(dir, "briefs");
  mkdirSync(briefs);
  const amended = brief(briefs, "amended.md");
  const kept = brief(briefs, "kept.md");
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(elsewhere);
  const ended = brief(elsewhere, "ended.md");
  for (const [name, file] of [
    ["task-a", amended],
    ["task-b", kept],
    ["gone", ended],
  ] as const)
    result(run(w, w.root, ["start", name, "--repo", dir, "--brief", file]));
  result(run(w, w.root, ["done", "gone"]));
  result(run(w, w.root, ["review", "task-b"]));
  writeFileSync(amended, "# Brief\n\nA fix.\n");
  expect(pluginName()).toBe("cniska-task");
  expect(Object.keys(registeredHooks())).toEqual(["SessionStart"]);
  expect(hookOf("SessionStart").matcher?.split("|").sort()).toEqual([
    "clear",
    "compact",
    "resume",
    "startup",
  ]);
  for (const cwd of [briefs, dir]) {
    const [heading, ...listed] = context(sessionStart(w, bin, cwd)).split("\n");
    expect(heading).toBe(
      "cniska-task: the running and in-review tasks, as agent-task list --started prints them:",
    );
    expect(`${listed.join("\n")}\n`).toBe(run(w, w.root, ["list", "--started"]).stdout);
    expect(decode(listed.join("\n"))).toMatchObject({
      command: "list",
      ok: true,
      result: {
        tasks: [
          { name: "task-a", state: "running", brief: amended, briefChanged: true },
          { name: "task-b", state: "review", brief: kept, briefChanged: false },
        ],
      },
    });
  }
  const empty = join(dir, "empty");
  mkdirSync(empty);
  for (const cwd of [empty, elsewhere]) expect(sessionStart(w, bin, cwd)).toEqual(SILENT);
  expect(sessionStart(w, bin, join(dir, "missing"), dir)).toEqual(SILENT);
});

test("AC-25 the session hook prints nothing and exits 0 over a store of a schema version agent-task cannot read, with no agent-task on PATH, and with only a note on stderr without jq", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(dir, "brief.md");
  const withCli = binWith(w, ON_PATH, true);
  result(run(w, w.root, ["start", "task-a", "--repo", dir, "--brief", file]));
  const db = new Database(join(w.root, "data", "agent-task", "tasks.db"));
  db.run("PRAGMA user_version = 4");
  db.close();
  expect(sessionStart(w, withCli, dir)).toEqual(SILENT);
  const fresh = world();
  const freshDir = repo(fresh);
  const freshBrief = brief(freshDir, "brief.md");
  result(run(fresh, fresh.root, ["start", "task-a", "--repo", freshDir, "--brief", freshBrief]));
  const withoutCli = binWith(fresh, ON_PATH, false);
  expect(sessionStart(fresh, withoutCli, freshDir)).toEqual(SILENT);
  for (const missing of ["jq"]) {
    const without = binWith(
      fresh,
      ON_PATH.filter((program) => program !== missing),
      true,
      `without-${missing}`,
    );
    const ran = sessionStart(fresh, without, freshDir);
    expect([ran.exitCode, ran.stdout]).toEqual([0, ""]);
    expect(ran.stderr).toStartWith(`cniska-task: ${missing} is not on PATH`);
    expect(ran.stderr.split("\n")).toHaveLength(2);
  }
});

test("AC-34 list --started prints the started tasks alone and runs no queued task's check, --brief-under prints them only from a directory holding a brief, and the session hook runs none", () => {
  const w = world();
  const bin = binWith(w, ON_PATH, true);
  const dir = repo(w);
  const file = brief(dir, "brief.md");
  result(run(w, w.root, ["start", "task-a", "--repo", dir, "--brief", file]));
  result(run(w, w.root, ["add", "marking", "--repo", dir, "--goal", "mark", "--until", ": > marker"]));
  const marker = join(dir, "marker");
  const started = result(run(w, w.root, ["list", "--started"]));
  expect(Object.keys(started)).toEqual(["count", "tasks"]);
  expect(started.tasks).toMatchObject([
    { name: "task-a", state: "running", brief: file, briefChanged: false },
  ]);
  expect(existsSync(marker)).toBe(false);
  const [, ...listed] = context(sessionStart(w, bin, dir)).split("\n");
  expect(decode(listed.join("\n"))).toMatchObject({ result: { tasks: [{ name: "task-a" }] } });
  expect(existsSync(marker)).toBe(false);
  const misused = run(w, w.root, ["list", "--started", "extra"]);
  expect([misused.exitCode, misused.stdout]).toEqual([2, ""]);
  expect(decode(misused.stderr)).toMatchObject({ error: { kind: "usage", code: "bad_arguments" } });
  expect(run(w, w.root, ["list", "--started", "--brief-under", dir])).toEqual(
    run(w, w.root, ["list", "--started"]),
  );
  const elsewhere = join(w.root, "elsewhere");
  mkdirSync(elsewhere);
  expect(refusal(run(w, w.root, ["list", "--started", "--brief-under", elsewhere]))).toMatchObject({
    code: "no_brief_under",
    meta: { dir: elsewhere },
    resolve: "agent-task list --started",
  });
  const unstarted = run(w, w.root, ["list", "--brief-under", dir]);
  expect([unstarted.exitCode, unstarted.stdout]).toEqual([2, ""]);
  expect(existsSync(marker)).toBe(false);
  expect(listing(run(w, w.root, ["list", "--full"])).ready).toMatchObject([
    { name: "marking", untilState: "met" },
  ]);
  expect(existsSync(marker)).toBe(true);
});
