import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { refusal, removeScratchDirs, result, run, setLimits, UNLIMITED, type World, world } from "./harness";

afterEach(removeScratchDirs);

const ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

const DEADLINE_MS = 15_000;

const LOOK_MS = 50;

type Checking = {
  readonly pid: number;
  readonly stderr: () => string;
  readonly exited: Promise<number>;
  readonly kill: () => void;
};

function checking(w: World, cwd: string, command: string): Checking {
  const child = Bun.spawn([process.execPath, ENTRY, "check", command], {
    cwd,
    env: w.env,
    stdout: "ignore",
    stderr: "pipe",
  });
  let stderr = "";
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of child.stderr) stderr += decoder.decode(chunk);
  })();
  return { pid: child.pid, stderr: () => stderr, exited: child.exited, kill: () => child.kill("SIGKILL") };
}

async function until(holds: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(LOOK_MS);
  }
}

function dirIn(w: World, name: string): string {
  const dir = join(w.root, name);
  mkdirSync(dir);
  return dir;
}

const WAIT_FOR_GO = "while [ ! -f go ]; do sleep 0.05; done";

const SLOT_LINE = "agent-task check: waiting for the check slot, held by process";

const MACHINE_LINE = "agent-task check: waiting for the machine, since the 1-minute load average is";

function lines(text: string, start: string): readonly string[] {
  return text.split("\n").filter((line) => line.startsWith(start));
}

test("AC-52 check runs the command with its output and exit code passed through, waits while the machine is over its limits, and takes one command and no flag", async () => {
  const w = world();
  const dir = dirIn(w, "app");
  const ran = run(w, dir, ["check", "printf out; printf err >&2; exit 3"]);
  expect(ran).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
  expect(run(w, dir, ["check", "kill -9 $$"]).exitCode).toBe(137);
  setLimits(w, { maxLoadPerCore: 0 });
  const waiting = checking(w, dir, "printf ran > marker");
  await until(() => waiting.stderr().includes(MACHINE_LINE), "the machine line");
  expect(waiting.stderr()).toContain("above the limit of 0");
  expect(existsSync(join(dir, "marker"))).toBe(false);
  setLimits(w, UNLIMITED);
  expect(await waiting.exited).toBe(0);
  expect(lines(waiting.stderr(), MACHINE_LINE)).toHaveLength(1);
  expect(existsSync(join(dir, "marker"))).toBe(true);
  for (const args of [[], ["true", "true"], [" "], ["--force", "true"], ["--no-limits", "true"]]) {
    const refused = run(w, dir, ["check", ...args]);
    expect([refused.exitCode, refused.stdout]).toEqual([2, ""]);
    expect(decode(refused.stderr)).toMatchObject({ error: { kind: "usage", code: "bad_arguments" } });
  }
});

test("AC-53 a check waits while another holds the slot, naming it, and runs once it ends", async () => {
  const w = world();
  const first = dirIn(w, "first");
  const second = dirIn(w, "second");
  const holding = checking(w, first, `touch started; ${WAIT_FOR_GO}`);
  await until(() => existsSync(join(first, "started")), "the first check to start");
  const waiting = checking(w, second, "printf ran > marker");
  await until(() => waiting.stderr().includes(SLOT_LINE), "the slot line");
  expect(waiting.stderr()).toContain(`${SLOT_LINE} ${holding.pid} since`);
  expect(waiting.stderr()).toContain(`running touch started; ${WAIT_FOR_GO} in ${first}`);
  expect(existsSync(join(second, "marker"))).toBe(false);
  writeFileSync(join(first, "go"), "");
  expect(await holding.exited).toBe(0);
  expect(await waiting.exited).toBe(0);
  expect(lines(waiting.stderr(), SLOT_LINE)).toHaveLength(1);
  expect(existsSync(join(second, "marker"))).toBe(true);
});

test("AC-54 the slot stays held until the killed check and every process still holding it end, then frees", async () => {
  const w = world();
  const first = dirIn(w, "first");
  const second = dirIn(w, "second");
  const killed = checking(w, first, `(${WAIT_FOR_GO}) & kill -9 $$`);
  expect(await killed.exited).toBe(137);
  const waiting = checking(w, second, "printf ran > marker");
  await until(() => waiting.stderr().includes(SLOT_LINE), "the slot line behind the background process");
  writeFileSync(join(first, "go"), "");
  expect(await waiting.exited).toBe(0);
  expect(existsSync(join(second, "marker"))).toBe(true);

  const third = dirIn(w, "third");
  const orphaned = checking(w, first, `rm -f go; touch orphan; ${WAIT_FOR_GO}`);
  await until(() => existsSync(join(first, "orphan")), "the check to start");
  orphaned.kill();
  await orphaned.exited;
  const behind = checking(w, third, "printf ran > marker");
  await until(() => behind.stderr().includes(SLOT_LINE), "the slot line behind the orphaned check");
  expect(existsSync(join(third, "marker"))).toBe(false);
  writeFileSync(join(first, "go"), "");
  expect(await behind.exited).toBe(0);
  expect(existsSync(join(third, "marker"))).toBe(true);
});

test("AC-55 check is refused halted while a halt is raised, before and while it waits, running nothing", async () => {
  const w = world();
  const dir = dirIn(w, "app");
  result(run(w, w.root, ["halt", "a flaw in the workflow"]));
  expect(refusal(run(w, dir, ["check", "printf ran > marker"]))).toMatchObject({ code: "halted" });
  result(run(w, w.root, ["resume"]));
  setLimits(w, { maxLoadPerCore: 0 });
  const waiting = checking(w, dir, "printf ran > marker");
  await until(() => waiting.stderr().includes(MACHINE_LINE), "the machine line");
  result(run(w, w.root, ["halt", "a flaw in the workflow"]));
  expect(await waiting.exited).toBe(1);
  expect(decode(waiting.stderr().slice(waiting.stderr().indexOf("command: check")))).toMatchObject({
    error: { code: "halted" },
  });
  expect(existsSync(join(dir, "marker"))).toBe(false);
  result(run(w, w.root, ["resume"]));
  setLimits(w, UNLIMITED);
  expect(run(w, dir, ["check", "printf ran > marker"]).exitCode).toBe(0);
  expect(existsSync(join(dir, "marker"))).toBe(true);
});

test("AC-56 gate refuses a command that runs a check outside agent-task check, naming the command to run instead", () => {
  const w = world();
  expect(refusal(run(w, w.root, ["gate", "cd app && mise run check"]))).toMatchObject({
    code: "check_ungated",
    meta: { command: "cd app && mise run check", checks: ["mise run check"] },
    resolve: expect.stringContaining("agent-task check 'cd app && mise run check'"),
  });
  for (const command of [
    "agent-task check 'cd app && mise run check'",
    "git commit -m 'bun test'",
    "mise run dev",
  ])
    expect(result(run(w, w.root, ["gate", command]))).toEqual({ gated: true });
  const bare = run(w, w.root, ["gate"]);
  expect([bare.exitCode, bare.stdout]).toEqual([2, ""]);
  expect(decode(bare.stderr)).toMatchObject({ error: { code: "bad_arguments" } });
});
