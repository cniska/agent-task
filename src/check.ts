import { dlopen, FFIType, read } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { closeSync, constants, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname } from "node:path";
import { invariant } from "./assert";
import { faults } from "./coded-error";
import type { ProcessEnv } from "./git";
import { refuseWhileHalted } from "./halt";
import { type Reading, strainOf, strainText } from "./machine";

const SHELL = "/bin/sh";

type Libc = { readonly path: string; readonly errno: string; readonly wouldBlock: number };

const LIBC: Readonly<Record<string, Libc>> = {
  darwin: { path: "/usr/lib/libSystem.B.dylib", errno: "__error", wouldBlock: 35 },
  linux: { path: "libc.so.6", errno: "__errno_location", wouldBlock: 11 },
};

const LOCK_EXCLUSIVE = 2;

const LOCK_NONBLOCKING = 4;

const SIGNAL_BASE = 128;

const SLOT_MODE = 0o644;

export type CheckRun = {
  readonly command: string;
  readonly cwd: string;
  readonly slotPath: string;
  readonly haltPath: string;
  readonly limitsPath: string;
  readonly readMachine: () => Reading;
  readonly processEnv: ProcessEnv;
  readonly now: () => Date;
  readonly pause: () => void;
  readonly say: (line: string) => void;
};

type Holder = {
  readonly pid: number;
  readonly command: string;
  readonly cwd: string;
  readonly started: string;
};

const fault = faults<{
  readonly slot_unlockable: { readonly path: string; readonly platform: string; readonly detail: string };
  readonly check_unrun: { readonly command: string; readonly detail: string };
}>({
  slot_unlockable: {
    message: ({ path, platform, detail }) =>
      `agent-task cannot lock the check slot ${path} on ${platform}: ${detail}`,
    resolve: () =>
      "stop and hand this error to the owner: agent-task check locks its slot with flock on macOS or Linux",
  },
  check_unrun: {
    message: ({ command, detail }) => `agent-task could not run the check ${command}: ${detail}`,
    resolve: () => `stop and hand this error to the owner: agent-task check runs the check with ${SHELL}`,
  },
});

type Locking = { readonly tryLock: (fd: number) => boolean; readonly close: () => void };

function slotLocking(path: string): Locking {
  const { platform } = process;
  const libc = LIBC[platform];
  if (libc === undefined)
    throw fault("slot_unlockable", { path, platform, detail: "it is neither macOS nor Linux" });
  const library = dlopen(libc.path, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [libc.errno]: { args: [], returns: FFIType.ptr },
  });
  const errno = library.symbols[libc.errno];
  invariant(errno !== undefined, "the errno function is among the symbols opened");
  const tryLock = (fd: number) => {
    if (library.symbols.flock(fd, LOCK_EXCLUSIVE | LOCK_NONBLOCKING) === 0) return true;
    const at = errno();
    invariant(at !== null, "errno lives at an address");
    const code = read.i32(at, 0);
    if (code === libc.wouldBlock) return false;
    throw fault("slot_unlockable", { path, platform, detail: `flock failed with errno ${code}` });
  };
  return { tryLock, close: () => library.close() };
}

function openSlot(path: string): number {
  mkdirSync(dirname(path), { recursive: true });
  return openSync(path, constants.O_RDWR | constants.O_CREAT, SLOT_MODE);
}

function textAt(value: unknown, key: string): string | number | null {
  const found: unknown = typeof value === "object" && value !== null ? Reflect.get(value, key) : null;
  return typeof found === "string" || typeof found === "number" ? found : null;
}

function holderText(path: string): string {
  let holder: unknown;
  try {
    holder = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    holder = null;
  }
  const [pid, command, cwd, started] = ["pid", "command", "cwd", "started"].map((key) => textAt(holder, key));
  if (pid === null || command === null || cwd === null || started === null) return "held by another check";
  return `held by process ${pid} since ${started}, running ${command} in ${cwd}`;
}

function claim(fd: number, holder: Holder): void {
  ftruncateSync(fd, 0);
  writeSync(fd, JSON.stringify(holder), 0);
}

type Say = (reason: string, line: string) => void;

function sayOnChange(say: (line: string) => void): Say {
  let last: string | null = null;
  return (reason, line) => {
    if (reason !== last) say(line);
    last = reason;
  };
}

function exitOf(status: number | null, signal: NodeJS.Signals | null): number {
  if (status !== null) return status;
  const number = signal === null ? undefined : osConstants.signals[signal];
  invariant(number !== undefined, "a check that ends with no status ends on a known signal");
  return SIGNAL_BASE + number;
}

function waitForSlot(run: CheckRun, fd: number, say: Say): void {
  const locking = slotLocking(run.slotPath);
  try {
    for (;;) {
      refuseWhileHalted(run.haltPath);
      if (locking.tryLock(fd)) return;
      const holder = holderText(run.slotPath);
      say(holder, `agent-task check: waiting for the check slot, ${holder}`);
      run.pause();
    }
  } finally {
    locking.close();
  }
}

function waitForMachine(run: CheckRun, say: Say): void {
  for (;;) {
    refuseWhileHalted(run.haltPath);
    const strain = strainOf(run);
    if (strain.over.length === 0) return;
    say(strain.over.join(), `agent-task check: waiting for the machine, since ${strainText(strain)}`);
    run.pause();
  }
}

export function runGatedCheck(run: CheckRun): number {
  refuseWhileHalted(run.haltPath);
  const fd = openSlot(run.slotPath);
  try {
    const say = sayOnChange(run.say);
    waitForSlot(run, fd, say);
    claim(fd, { pid: process.pid, command: run.command, cwd: run.cwd, started: run.now().toISOString() });
    waitForMachine(run, say);
    refuseWhileHalted(run.haltPath);
    const ran = spawnSync(SHELL, ["-c", run.command], {
      cwd: run.cwd,
      env: run.processEnv,
      stdio: ["inherit", "inherit", "inherit", fd],
    });
    if (ran.error) throw fault("check_unrun", { command: run.command, detail: ran.error.message });
    return exitOf(ran.status, ran.signal);
  } finally {
    closeSync(fd);
  }
}
