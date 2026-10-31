import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const [entry] = handler.hooks;
  if (!isRecord(entry) || entry.type !== "command" || typeof entry.command !== "string")
    throw new Error("a hook is a command");
  return { matcher, command: entry.command };
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

const NOTE = readFileSync(join(PLUGIN, "hooks", "note.md"), "utf8");

function noted(ran: Ran): string {
  expect([ran.exitCode, ran.stderr]).toEqual([0, ""]);
  expect(ran.stdout).toStartWith(NOTE);
  return ran.stdout.slice(NOTE.length);
}

function context(ran: Ran): string {
  const after = noted(ran);
  expect(after).toStartWith("\n");
  return after.slice(1).replace(/\n$/, "");
}

const NOTED = { exitCode: 0, stdout: NOTE, stderr: "" };

const UNCHECKED_LINE =
  "cniska-task: agent-task could not say whether agent work on this machine is halted, so this session's edits, shell commands and agents go unchecked against a halt.\n";

const UNCHECKED = { exitCode: 0, stdout: UNCHECKED_LINE, stderr: "" };

test("AC-24 the session hook adds its note naming agent-task's commands from any directory, then the running and in-review tasks where the working directory holds one of their briefs", () => {
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
  for (const named of [
    "not in a ledger, a notes file or a plan",
    "`agent-task add`",
    "`agent-task start`",
    "`agent-task done`",
  ])
    expect(NOTE).toContain(named);
  expect(pluginName()).toBe("cniska-task");
  expect(Object.keys(registeredHooks())).toEqual(["SessionStart", "PreToolUse"]);
  expect(hookOf("SessionStart").matcher?.split("|").toSorted()).toEqual([
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
  for (const cwd of [empty, elsewhere]) expect(sessionStart(w, bin, cwd)).toEqual(NOTED);
  expect(sessionStart(w, bin, join(dir, "missing"), dir)).toEqual(NOTED);
});

test("AC-25 the session hook prints its note alone with no task started, over a store it cannot read and from input naming no directory, says the halt could not be checked with no agent-task on PATH, and adds a stderr line without jq", () => {
  const w = world();
  const dir = repo(w);
  const file = brief(dir, "brief.md");
  const withCli = binWith(w, ON_PATH, true);
  result(run(w, w.root, ["start", "task-a", "--repo", dir, "--brief", file]));
  const db = new Database(join(w.root, "data", "agent-task", "tasks.db"));
  db.run("PRAGMA user_version = 99");
  db.close();
  expect(sessionStart(w, withCli, dir)).toEqual(NOTED);
  const fresh = world();
  const freshDir = repo(fresh);
  const freshBrief = brief(freshDir, "brief.md");
  const freshBin = binWith(fresh, ON_PATH, true, "fresh");
  expect(sessionStart(fresh, freshBin, freshDir)).toEqual(NOTED);
  result(run(fresh, fresh.root, ["start", "task-a", "--repo", freshDir, "--brief", freshBrief]));
  const withoutCli = binWith(fresh, ON_PATH, false);
  expect(sessionStart(fresh, withoutCli, freshDir)).toEqual(UNCHECKED);
  expect(hook(fresh, freshBin, "SessionStart", freshDir, { hook_event_name: "SessionStart" })).toEqual(NOTED);
  for (const missing of ["jq"]) {
    const without = binWith(
      fresh,
      ON_PATH.filter((program) => program !== missing),
      true,
      `without-${missing}`,
    );
    const ran = sessionStart(fresh, without, freshDir);
    expect([ran.exitCode, ran.stdout]).toEqual([0, NOTE]);
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
  expect(Object.keys(started)).toEqual(["counts", "tasks"]);
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

const REASON = "a flaw in the workflow";

const HALTED_LINE =
  "cniska-task: all agent work on this machine is halted, so this tool call is refused. Make no further change: state your report and stop. Only the owner lifts the halt. agent-task halted reports:";

const HALT_HEADING =
  "cniska-task: all agent work on this machine is halted. Make no change: state your report and stop. Only the owner lifts the halt. agent-task halted reports:";

function stubCli(w: World, name: string, script: string): string {
  const bin = binWith(w, ON_PATH, false, name);
  const path = join(bin, "agent-task");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return bin;
}

function olderCli(w: World): string {
  return stubCli(
    w,
    "older",
    'if [ "$1" = --version ]; then echo 0.2.1; exit 0; fi\nprintf "command: agent-task\\nok: false\\nerror:\\n  kind: usage\\n  code: unknown_command\\n" >&2\nexit 2',
  );
}

function toolCall(w: World, bin: string, tool: string, toolInput: unknown): Ran {
  return hook(w, bin, "PreToolUse", w.root, {
    hook_event_name: "PreToolUse",
    cwd: w.root,
    tool_name: tool,
    tool_input: toolInput,
  });
}

const EDIT = { file_path: "/work/a.ts", old_string: "a", new_string: "b" };

const PASSED = { exitCode: 0, stdout: "", stderr: "" };

function refused(ran: Ran, halted: string): void {
  expect([ran.exitCode, ran.stdout]).toEqual([2, ""]);
  expect(ran.stderr).toBe(`${HALTED_LINE}\n${halted}`);
  expect(ran.stderr).toContain(REASON);
}

test("AC-39 the tool hook refuses edits, writes, agents and every shell command but agent-task's alone while a halt is raised, refuses input it cannot read, and lets every call through when it cannot ask agent-task", () => {
  const w = world();
  const bin = binWith(w, ON_PATH, true);
  expect(hookOf("PreToolUse").matcher?.split("|").toSorted()).toEqual([
    "Agent",
    "Bash",
    "Edit",
    "EnterWorktree",
    "Monitor",
    "NotebookEdit",
    "PowerShell",
    "Workflow",
    "Write",
  ]);
  expect(toolCall(w, bin, "Edit", EDIT)).toEqual(PASSED);
  expect(toolCall(w, bin, "Bash", { command: "ls" })).toEqual(PASSED);
  result(run(w, w.root, ["halt", REASON]));
  const halted = run(w, w.root, ["halted"]).stderr;
  expect(halted).toContain(REASON);
  for (const [tool, input] of [
    ["Edit", EDIT],
    ["Write", { file_path: "/work/a.ts", content: "a" }],
    ["NotebookEdit", { notebook_path: "/work/a.ipynb", new_source: "a" }],
    ["Agent", { description: "work", prompt: "work" }],
    ["Monitor", { command: "agent-task list" }],
  ] as const)
    refused(toolCall(w, bin, tool, input), halted);
  for (const command of [
    "ls",
    "agent-task list && rm -rf x",
    "agent-task list; ls",
    "agent-task $(ls)",
    "agent-task `ls`",
    "agent-task list | sh",
    "agent-task list > x",
    "agent-task list\nls",
    "agent-taskx",
  ])
    refused(toolCall(w, bin, "Bash", { command }), halted);
  for (const command of ["agent-task list", 'agent-task halt "another reason"', "agent-task resume"])
    expect(toolCall(w, bin, "Bash", { command })).toEqual(PASSED);
  expect(toolCall(w, bin, "PowerShell", { command: "agent-task list" })).toEqual(PASSED);
  const unparsed = spawnSync(SHELL, ["-c", hookOf("PreToolUse").command], {
    cwd: w.root,
    encoding: "utf8",
    input: "not json",
    env: { ...w.env, PATH: bin, CLAUDE_PLUGIN_ROOT: PLUGIN },
  });
  expect(unparsed.status).toBe(2);
  const withoutJq = binWith(w, ["bash", "git"], true, "without-jq");
  refused(toolCall(w, withoutJq, "Bash", { command: "agent-task list" }), halted);
  const withoutCli = binWith(w, ON_PATH, false, "without-cli");
  expect(toolCall(w, withoutCli, "Edit", EDIT)).toEqual(PASSED);
  expect(toolCall(w, olderCli(w), "Edit", EDIT)).toEqual(PASSED);
  expect(toolCall(w, stubCli(w, "broken", "exit 1"), "Edit", EDIT)).toEqual(PASSED);
  result(run(w, w.root, ["resume"]));
  expect(toolCall(w, bin, "Edit", EDIT)).toEqual(PASSED);
});

test("AC-40 the session hook puts a raised halt and its reason before the note, says when the halt could not be checked, and prints the note alone once the halt is lifted", () => {
  const w = world();
  const bin = binWith(w, ON_PATH, true);
  result(run(w, w.root, ["halt", REASON]));
  const halted = run(w, w.root, ["halted"]).stderr;
  const ran = sessionStart(w, bin, w.root);
  expect([ran.exitCode, ran.stderr]).toEqual([0, ""]);
  expect(ran.stdout).toBe(`${HALT_HEADING}\n${halted}\n${NOTE}`);
  expect(ran.stdout).toContain(REASON);
  expect(sessionStart(w, olderCli(w), w.root)).toEqual({
    exitCode: 0,
    stdout: `${UNCHECKED_LINE}\n${NOTE}`,
    stderr: "",
  });
  result(run(w, w.root, ["resume"]));
  expect(sessionStart(w, bin, w.root)).toEqual(NOTED);
});

const OWNER_HEADING =
  "cniska-task: what waits on the owner, by project, as agent-task list --owner prints it:";

test("AC-49 the session hook prints the owner items after the note, grouped by project with the unmapped last, from any directory and without jq, before the started tasks, and nothing of them when none waits", () => {
  const w = world();
  const bin = binWith(w, ON_PATH, true);
  const dir = repo(w);
  const file = brief(dir);
  for (const id of ["site", "app"]) {
    result(run(w, w.root, ["project", "add", id, "--name", `The ${id}`, "--repo", dir, "--dir", dir]));
    result(run(w, w.root, ["ask", `ask-${id}`, `Answer for ${id}`, "--project", id]));
  }
  result(run(w, w.root, ["ask", "ask-none", "Rotate the deploy key"]));
  const owner = run(w, w.root, ["list", "--owner"]).stdout;
  expect(decode(owner)).toMatchObject({
    result: {
      owner: [
        { project: "app", items: [{ name: "ask-app" }] },
        { project: "site", items: [{ name: "ask-site" }] },
        { project: null, items: [{ name: "ask-none" }] },
      ],
    },
  });
  const section = `${NOTE}\n${OWNER_HEADING}\n${owner}`;
  expect(sessionStart(w, bin, w.root)).toEqual({ exitCode: 0, stdout: section, stderr: "" });
  expect(hook(w, bin, "SessionStart", w.root, { hook_event_name: "SessionStart" })).toEqual({
    exitCode: 0,
    stdout: section,
    stderr: "",
  });
  const withoutJq = binWith(w, ["bash", "git"], true, "without-jq");
  const ran = sessionStart(w, withoutJq, w.root);
  expect([ran.exitCode, ran.stdout]).toEqual([0, section]);
  expect(ran.stderr).toStartWith("cniska-task: jq is not on PATH");
  result(run(w, w.root, ["start", "task-a", "--repo", dir, "--brief", file]));
  const started = sessionStart(w, bin, dir);
  expect(started.stdout).toBe(
    `${section}\ncniska-task: the running and in-review tasks, as agent-task list --started prints them:\n${run(w, w.root, ["list", "--started"]).stdout}`,
  );
  for (const name of ["ask-site", "ask-app", "ask-none"]) result(run(w, w.root, ["done", name]));
  const elsewhere = join(w.root, "elsewhere");
  mkdirSync(elsewhere);
  expect(sessionStart(w, bin, elsewhere)).toEqual(NOTED);
});
