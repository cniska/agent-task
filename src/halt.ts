import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { unreachable } from "./assert";
import { messageOf, refusals } from "./coded-error";

type Raised = { readonly state: "raised"; readonly reason: string; readonly raised: string };

type Unreadable = { readonly state: "unreadable"; readonly path: string; readonly detail: string };

type Halting = Raised | Unreadable;

export type Halt = { readonly state: "none" } | Halting;

const NONE: Halt = { state: "none" };

const MISSING = "ENOENT";

const RECORD_KEYS = ["raised", "reason"];

export const HALT_USAGE = {
  halt: "agent-task halt <reason>",
  resume: "agent-task resume",
  halted: "agent-task halted",
} as const;

const OWNER_RESUMES = `make no change: state your report and stop; only the owner lifts the halt, with ${HALT_USAGE.resume}`;

const refuse = refusals<{
  readonly halted: Halting;
  readonly halt_unremovable: { readonly path: string; readonly detail: string };
}>({
  halted: {
    message: (halt) => {
      switch (halt.state) {
        case "raised":
          return `all agent work on this machine is halted, since ${halt.raised}: ${halt.reason}`;
        case "unreadable":
          return `a halt is recorded at ${halt.path} that cannot be read, so all agent work on this machine counts as halted: ${halt.detail}`;
        default:
          return unreachable(halt);
      }
    },
    resolve: () => OWNER_RESUMES,
  },
  halt_unremovable: {
    message: ({ path, detail }) => `the halt recorded at ${path} cannot be removed: ${detail}`,
    resolve: ({ path }) =>
      `stop and hand this error to the owner: ${path} must be a file agent-task can remove`,
  },
});

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHalt(path: string, text: string): Halting {
  const unreadable = (detail: string): Unreadable => ({ state: "unreadable", path, detail });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return unreadable(`it is not JSON: ${messageOf(error)}`);
  }
  if (!isRecord(value)) return unreadable("it holds no halt record");
  const keys = Object.keys(value).toSorted();
  if (keys.join() !== RECORD_KEYS.join()) return unreadable(`it holds the keys ${keys.join(", ") || "none"}`);
  const { reason, raised } = value;
  if (typeof reason !== "string" || reason.trim() === "") return unreadable("its reason is not text");
  if (typeof raised !== "string") return unreadable("its time is not text");
  return { state: "raised", reason, raised };
}

export function readHalt(path: string): Halt {
  try {
    return parseHalt(path, readFileSync(path, "utf8"));
  } catch (error) {
    if (errorCode(error) !== MISSING) return { state: "unreadable", path, detail: messageOf(error) };
    if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return NONE;
    return { state: "unreadable", path, detail: "it is a link that points at nothing" };
  }
}

export function refuseWhileHalted(path: string): void {
  const halt = readHalt(path);
  if (halt.state !== "none") throw refuse("halted", halt);
}

function published(path: string, record: Raised): boolean {
  const staged = `${path}.${randomUUID()}`;
  writeFileSync(staged, `${JSON.stringify({ reason: record.reason, raised: record.raised })}\n`);
  try {
    linkSync(staged, path);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(staged);
  }
}

export function raiseHalt(path: string, reason: string, now: Date): Halt {
  const held = readHalt(path);
  if (held.state !== "none") return held;
  mkdirSync(dirname(path), { recursive: true });
  const record: Raised = { state: "raised", reason, raised: now.toISOString() };
  if (published(path, record)) return record;
  return readHalt(path);
}

export function liftHalt(path: string): Halt {
  const lifted = readHalt(path);
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) === MISSING) return NONE;
    throw refuse("halt_unremovable", { path, detail: messageOf(error) });
  }
  return lifted;
}

export function haltedNow(path: string): Halt {
  refuseWhileHalted(path);
  return NONE;
}
