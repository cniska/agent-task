import { dlopen, FFIType } from "bun:ffi";
import { lstatSync, readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { invariant, unreachable } from "./assert";
import { messageOf, refusals } from "./coded-error";
import { actFor, USAGE } from "./usage";

export type Reading = {
  readonly loadAverage: number;
  readonly cores: number;
  readonly availableMemory: number;
};

export type Limits = { readonly maxLoadPerCore: number; readonly minAvailableMemory: number };

export const DEFAULT_LIMITS: Limits = { maxLoadPerCore: 0.7, minAvailableMemory: 0.15 };

type Over = "load" | "memory";

export type Strain = {
  readonly over: readonly Over[];
  readonly load: {
    readonly average: number;
    readonly cores: number;
    readonly perCore: number;
    readonly limit: number;
  };
  readonly memory: { readonly available: number; readonly limit: number };
};

type Busy = Strain & { readonly name: string; readonly path: string };

const LIMIT_KEYS = new Set<string>(Object.keys(DEFAULT_LIMITS));

const MEMINFO = "/proc/meminfo";

const MEM_TOTAL = /^MemTotal:\s+(\d+) kB$/m;

const MEM_AVAILABLE = /^MemAvailable:\s+(\d+) kB$/m;

const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";

const MEMORY_LEVEL = new TextEncoder().encode("kern.memorystatus_level\0");

const PERCENT = 100;

const OWNER_SETS = "only the owner changes this machine's limits";

function percent(share: number): string {
  return `${Math.round(share * PERCENT)}%`;
}

function rounded(value: number): number {
  return Math.round(value * PERCENT) / PERCENT;
}

function overText(strain: Strain, over: Over): string {
  switch (over) {
    case "load":
      return `the 1-minute load average is ${strain.load.average} on ${strain.load.cores} cores, ${strain.load.perCore} per core, above the limit of ${strain.load.limit}`;
    case "memory":
      return `${percent(strain.memory.available)} of memory is available, below the limit of ${percent(strain.memory.limit)}`;
    default:
      return unreachable(over);
  }
}

export function strainText(strain: Strain): string {
  return strain.over.map((over) => overText(strain, over)).join("; ");
}

const refuse = refusals<{
  readonly machine_busy: Busy;
  readonly limits_unreadable: { readonly path: string; readonly detail: string };
  readonly machine_unread: { readonly platform: string; readonly detail: string };
}>({
  machine_busy: {
    message: (busy) => `this machine is too busy to start another task: ${strainText(busy)}`,
    resolve: ({ name, path }) =>
      `start nothing now; retry ${actFor(USAGE.start, name)} once the machine is less busy; ${OWNER_SETS}, in ${path}`,
  },
  limits_unreadable: {
    message: ({ path, detail }) => `this machine's limits at ${path} cannot be read: ${detail}`,
    resolve: ({ path }) =>
      `stop and hand this error to the owner: ${path} must be a JSON object of maxLoadPerCore, a number of at least 0, and minAvailableMemory, a share from 0 to 1, each optional`,
  },
  machine_unread: {
    message: ({ platform, detail }) =>
      `agent-task cannot read how busy this ${platform} machine is: ${detail}`,
    resolve: () =>
      "stop and hand this error to the owner: agent-task start and check read the load average and the available memory from macOS or Linux",
  },
});

function limitOf(path: string, key: string, value: unknown): number {
  const unreadable = (detail: string) => refuse("limits_unreadable", { path, detail });
  if (!LIMIT_KEYS.has(key)) throw unreadable(`it holds the unknown key ${key}`);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw unreadable(`its ${key} is not a number of at least 0`);
  if (key === "minAvailableMemory" && value > 1)
    throw unreadable(`its minAvailableMemory is not a share from 0 to 1`);
  return value;
}

function parseLimits(path: string, text: string): Limits {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw refuse("limits_unreadable", { path, detail: `it is not JSON: ${messageOf(error)}` });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw refuse("limits_unreadable", { path, detail: "it holds no JSON object" });
  const set = Object.entries(value).map(([key, limit]) => [key, limitOf(path, key, limit)]);
  return { ...DEFAULT_LIMITS, ...Object.fromEntries(set) };
}

export function readLimits(path: string): Limits {
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return DEFAULT_LIMITS;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw refuse("limits_unreadable", { path, detail: messageOf(error) });
  }
  return parseLimits(path, text);
}

function linuxUnread(detail: string) {
  return refuse("machine_unread", { platform: "linux", detail });
}

function linuxAvailableMemory(): number {
  let text: string;
  try {
    text = readFileSync(MEMINFO, "utf8");
  } catch (error) {
    throw linuxUnread(messageOf(error));
  }
  const total = MEM_TOTAL.exec(text)?.[1];
  const available = MEM_AVAILABLE.exec(text)?.[1];
  if (total === undefined || available === undefined)
    throw linuxUnread(`${MEMINFO} names no MemTotal and MemAvailable`);
  return Number(available) / Number(total);
}

function darwinAvailableMemory(): number {
  const library = dlopen(LIBSYSTEM, {
    sysctlbyname: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
  });
  try {
    const level = new Int32Array(1);
    const size = new BigUint64Array([BigInt(level.byteLength)]);
    if (library.symbols.sysctlbyname(MEMORY_LEVEL, level, size, null, 0) !== 0)
      throw refuse("machine_unread", { platform: "darwin", detail: "sysctl kern.memorystatus_level failed" });
    const [percentAvailable] = level;
    invariant(percentAvailable !== undefined, "an Int32Array of one holds one value");
    return percentAvailable / PERCENT;
  } finally {
    library.close();
  }
}

function availableMemory(): number {
  if (process.platform === "darwin") return darwinAvailableMemory();
  if (process.platform === "linux") return linuxAvailableMemory();
  throw refuse("machine_unread", { platform: process.platform, detail: "it is neither macOS nor Linux" });
}

export function readMachine(): Reading {
  const [loadAverage] = loadavg();
  invariant(loadAverage !== undefined, "loadavg returns the 1, 5 and 15-minute averages");
  const cores = cpus().length;
  if (cores === 0)
    throw refuse("machine_unread", { platform: process.platform, detail: "it reports no CPU core" });
  return { loadAverage, cores, availableMemory: availableMemory() };
}

export type MachineCheck = { readonly limitsPath: string; readonly readMachine: () => Reading };

export function strainOf({ limitsPath, readMachine: read }: MachineCheck): Strain {
  const limits = readLimits(limitsPath);
  const reading = read();
  const perCore = reading.loadAverage / reading.cores;
  const over: Over[] = [];
  if (perCore > limits.maxLoadPerCore) over.push("load");
  if (reading.availableMemory < limits.minAvailableMemory) over.push("memory");
  return {
    over,
    load: {
      average: rounded(reading.loadAverage),
      cores: reading.cores,
      perCore: rounded(perCore),
      limit: limits.maxLoadPerCore,
    },
    memory: { available: rounded(reading.availableMemory), limit: limits.minAvailableMemory },
  };
}

export function refuseWhileBusy(check: MachineCheck, name: string): void {
  const strain = strainOf(check);
  if (strain.over.length === 0) return;
  throw refuse("machine_busy", { name, ...strain, path: check.limitsPath });
}
