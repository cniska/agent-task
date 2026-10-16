import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { binWith, brief, type Ran, removeScratch, repo, result, run, type World, world } from "./harness";

afterEach(removeScratch);

const PLUGIN = join(import.meta.dir, "..", "plugin");

const SHELL = "/bin/sh";

const ON_PATH = ["bash", "git", "jq", "realpath"];

type Hook = { readonly matcher: string | null; readonly command: string };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hookOf(event: string): Hook {
  const parsed: unknown = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) throw new Error("hooks.json holds a hooks object");
  const handlers = parsed.hooks[event];
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

function edit(w: World, bin: string, cwd: string, tool: string, file: string): Ran {
  return hook(w, bin, "PreToolUse", cwd, {
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { file_path: file },
    cwd,
  });
}

function sessionStart(w: World, bin: string, cwd: string, from = cwd): Ran {
  return hook(w, bin, "SessionStart", from, { hook_event_name: "SessionStart", source: "startup", cwd });
}

function denial(ran: Ran): string {
  expect([ran.exitCode, ran.stderr]).toEqual([0, ""]);
  const printed: unknown = JSON.parse(ran.stdout);
  if (!isRecord(printed) || !isRecord(printed.hookSpecificOutput)) throw new Error("no hookSpecificOutput");
  const { hookEventName, permissionDecision, permissionDecisionReason } = printed.hookSpecificOutput;
  expect([hookEventName, permissionDecision]).toEqual(["PreToolUse", "deny"]);
  if (typeof permissionDecisionReason !== "string") throw new Error("no reason");
  return permissionDecisionReason;
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

test("AC-17 the edit hook denies an edit to a running task's brief through each tool, naming stop, the edit and start again, and passes another file", () => {
  const w = world();
  const bin = binWith(w, ON_PATH, true);
  const dir = repo(w);
  const file = brief(dir, "brief.md");
  const other = brief(dir, "notes.md");
  result(run(w, w.root, ["start", "task-a", "--repo", dir, "--brief", file]));
  expect(pluginName()).toBe("cniska-task");
  expect(hookOf("PreToolUse").matcher).toBe("Edit|Write|MultiEdit");
  for (const [tool, path] of [
    ["Edit", file],
    ["Write", file],
    ["MultiEdit", "brief.md"],
  ] as const) {
    const reason = denial(edit(w, bin, dir, tool, path));
    expect(reason).toContain(`${file} is the brief of the running task task-a`);
    expect(reason).toContain("agent-task stop task-a;");
    expect(reason).toContain(`agent-task start task-a --repo ${dir} --brief ${file} [--session <id>]`);
    expect(reason.indexOf("agent-task stop")).toBeLessThan(reason.indexOf("then edit"));
    expect(reason.indexOf("then edit")).toBeLessThan(reason.indexOf("agent-task start"));
  }
  expect(edit(w, bin, dir, "Edit", other)).toEqual(SILENT);
  expect(edit(w, bin, dir, "Write", join(dir, "new.md"))).toEqual(SILENT);
  rmSync(file);
  expect(denial(edit(w, bin, dir, "Write", file))).toContain("agent-task stop task-a;");
  const nested = join(dir, "briefs", "deep");
  mkdirSync(nested, { recursive: true });
  const buried = brief(nested, "buried.md");
  result(run(w, w.root, ["start", "task-b", "--repo", dir, "--brief", buried]));
  rmSync(join(dir, "briefs"), { recursive: true });
  expect(denial(edit(w, bin, dir, "Write", buried))).toContain("agent-task stop task-b;");
  const noCwd = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "brief.md" } };
  expect(hook(w, bin, "PreToolUse", dir, noCwd)).toEqual(SILENT);
});

test("AC-18 the session hook puts the running tasks in context where the working directory holds a running brief, and prints nothing elsewhere", () => {
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
  writeFileSync(amended, "# Brief\n\nA fix.\n");
  expect(hookOf("SessionStart").matcher?.split("|").sort()).toEqual([
    "clear",
    "compact",
    "resume",
    "startup",
  ]);
  for (const cwd of [briefs, dir]) {
    const text = context(sessionStart(w, bin, cwd));
    const [heading, listed, closing] = text.split("\n");
    expect(heading).toBe("cniska-task: the running tasks, as agent-task list prints them:");
    expect(JSON.parse(listed ?? "")).toMatchObject({
      tasks: [
        { name: "task-a", brief: amended, briefChanged: true },
        { name: "task-b", brief: kept, briefChanged: false },
      ],
    });
    expect(closing).toContain("the plugin denies an edit to one, naming agent-task stop");
  }
  const empty = join(dir, "empty");
  mkdirSync(empty);
  for (const cwd of [empty, elsewhere]) expect(sessionStart(w, bin, cwd)).toEqual(SILENT);
  expect(sessionStart(w, bin, join(dir, "missing"), dir)).toEqual(SILENT);
});

test("AC-19 both hooks print nothing and exit 0 over a store of a schema version agent-task cannot read, with no agent-task on PATH, and with only a note on stderr without jq or realpath", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(dir, "brief.md");
  const withCli = binWith(w, ON_PATH, true);
  result(run(w, w.root, ["start", "task-a", "--repo", dir, "--brief", file]));
  const db = new Database(join(w.root, "data", "agent-task", "tasks.db"));
  db.run("PRAGMA user_version = 3");
  db.close();
  expect(edit(w, withCli, dir, "Edit", file)).toEqual(SILENT);
  expect(sessionStart(w, withCli, dir)).toEqual(SILENT);
  const fresh = world();
  const freshDir = repo(fresh);
  const freshBrief = brief(freshDir, "brief.md");
  result(run(fresh, fresh.root, ["start", "task-a", "--repo", freshDir, "--brief", freshBrief]));
  const withoutCli = binWith(fresh, ON_PATH, false);
  expect(edit(fresh, withoutCli, freshDir, "Edit", freshBrief)).toEqual(SILENT);
  expect(sessionStart(fresh, withoutCli, freshDir)).toEqual(SILENT);
  for (const missing of ["jq", "realpath"]) {
    const without = binWith(
      fresh,
      ON_PATH.filter((program) => program !== missing),
      true,
      `without-${missing}`,
    );
    for (const ran of [
      edit(fresh, without, freshDir, "Edit", freshBrief),
      sessionStart(fresh, without, freshDir),
    ]) {
      expect([ran.exitCode, ran.stdout]).toEqual([0, ""]);
      expect(ran.stderr).toStartWith(`cniska-task: ${missing} is not on PATH`);
      expect(ran.stderr.split("\n")).toHaveLength(2);
    }
  }
});
