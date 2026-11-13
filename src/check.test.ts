import { dlopen, FFIType } from "bun:ffi";
import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CheckRun, runGatedCheck } from "./check";
import { raiseHalt } from "./halt";
import type { Reading } from "./machine";
import { removeScratchDirs, scratchDir } from "./repo.test-support";

afterAll(removeScratchDirs);

const CALM: Reading = { loadAverage: 1, cores: 10, availableMemory: 0.5 };

const LOADED: Reading = { loadAverage: 12, cores: 10, availableMemory: 0.5 };

const STARTED = new Date("2026-11-13T13:00:00.000Z");

const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

const LOCK_EXCLUSIVE_NONBLOCKING = 6;

function locked(path: string): number | null {
  const fd = openSync(path, "a+");
  if (libc.symbols.flock(fd, LOCK_EXCLUSIVE_NONBLOCKING) === 0) return fd;
  closeSync(fd);
  return null;
}

type Checking = CheckRun & { readonly said: string[]; readonly dir: string };

function checking(overrides: Partial<CheckRun> = {}): Checking {
  const dir = scratchDir();
  const store = join(dir, "agent-task");
  mkdirSync(store);
  const said: string[] = [];
  return {
    dir,
    said,
    command: "true",
    cwd: dir,
    slotPath: join(store, "check.lock"),
    haltPath: join(store, "halt.json"),
    limitsPath: join(store, "limits.json"),
    readMachine: () => CALM,
    processEnv: process.env,
    now: () => STARTED,
    pause: () => {
      throw new Error("the check waited on a calm machine with a free slot");
    },
    say: (line) => said.push(line),
    ...overrides,
  };
}

describe("runGatedCheck", () => {
  test("runs the command with /bin/sh in the directory given and returns its exit code, saying nothing", () => {
    const run = checking();
    expect(runGatedCheck({ ...run, command: "printf ran > marker; exit 3" })).toBe(3);
    expect(existsSync(join(run.dir, "marker"))).toBe(true);
    expect(run.said).toEqual([]);
  });

  test("returns 128 and the signal's number for a check killed by a signal, and frees the slot", () => {
    const run = checking();
    expect(runGatedCheck({ ...run, command: "kill -9 $$" })).toBe(137);
    const fd = locked(run.slotPath);
    expect(fd).not.toBeNull();
    if (fd !== null) closeSync(fd);
  });

  test("waits while another check holds the slot, naming it once, then runs and frees it", () => {
    const run = checking();
    const holder = locked(run.slotPath);
    if (holder === null) throw new Error("the slot was held before the test");
    writeFileSync(
      run.slotPath,
      JSON.stringify({
        pid: 41,
        command: "mise run check",
        cwd: "/work/app",
        started: "2026-11-13T12:00:00.000Z",
      }),
    );
    let pauses = 0;
    const pause = () => {
      pauses += 1;
      if (pauses === 2) closeSync(holder);
    };
    expect(runGatedCheck({ ...run, command: "exit 0", pause })).toBe(0);
    expect(pauses).toBe(2);
    expect(run.said).toEqual([
      "agent-task check: waiting for the check slot, held by process 41 since 2026-11-13T12:00:00.000Z, running mise run check in /work/app",
    ]);
    const fd = locked(run.slotPath);
    expect(fd).not.toBeNull();
    if (fd !== null) closeSync(fd);
  });

  test("holding the slot, waits while the machine is over its limits, naming each reading over once while the same ones stay over, then runs", () => {
    let pauses = 0;
    const run = checking({
      readMachine: () => (pauses < 2 ? { ...LOADED, loadAverage: 12 + pauses } : CALM),
      pause: () => {
        pauses += 1;
      },
    });
    expect(runGatedCheck({ ...run, command: "printf ran > marker" })).toBe(0);
    expect(run.said).toEqual([
      "agent-task check: waiting for the machine, since the 1-minute load average is 12 on 10 cores, 1.2 per core, above the limit of 0.7",
    ]);
    expect(existsSync(join(run.dir, "marker"))).toBe(true);
  });

  test("records the check holding the slot, for a waiter to name", () => {
    const run = checking();
    expect(runGatedCheck({ ...run, command: `cat "${run.slotPath}" > holder.json` })).toBe(0);
    expect(JSON.parse(readFileSync(join(run.dir, "holder.json"), "utf8"))).toEqual({
      pid: process.pid,
      command: `cat "${run.slotPath}" > holder.json`,
      cwd: run.dir,
      started: STARTED.toISOString(),
    });
  });

  test("is refused halted while a halt is raised, before the wait and during it, running nothing and freeing the slot", () => {
    const halted = checking();
    raiseHalt(halted.haltPath, "a flaw in the workflow", STARTED);
    expect(() => runGatedCheck({ ...halted, command: "printf ran > marker" })).toThrow(
      expect.objectContaining({ code: "halted" }),
    );
    expect(existsSync(join(halted.dir, "marker"))).toBe(false);

    const run = checking({
      readMachine: () => LOADED,
      pause: () => {
        raiseHalt(run.haltPath, "a flaw in the workflow", STARTED);
      },
    });
    expect(() => runGatedCheck({ ...run, command: "printf ran > marker" })).toThrow(
      expect.objectContaining({ code: "halted" }),
    );
    expect(existsSync(join(run.dir, "marker"))).toBe(false);
    const fd = locked(run.slotPath);
    expect(fd).not.toBeNull();
    if (fd !== null) closeSync(fd);
  });

  test("is refused limits_unreadable for a limits file it cannot read", () => {
    const run = checking();
    writeFileSync(run.limitsPath, "not json");
    expect(() => runGatedCheck(run)).toThrow(expect.objectContaining({ code: "limits_unreadable" }));
  });
});
