import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS, readLimits, readMachine, refuseWhileBusy } from "./machine";
import { removeScratchDirs, scratchDir } from "./repo.test-support";

afterAll(removeScratchDirs);

function limitsFile(text: string): string {
  const path = join(scratchDir(), "limits.json");
  writeFileSync(path, text);
  return path;
}

describe("the limits", () => {
  test("default to 0.7 load per core and 15% of memory available when no file is set", () => {
    expect(DEFAULT_LIMITS).toEqual({ maxLoadPerCore: 0.7, minAvailableMemory: 0.15 });
    expect(readLimits(join(scratchDir(), "limits.json"))).toEqual(DEFAULT_LIMITS);
  });

  test("take each limit the file sets and the default of the other", () => {
    expect(readLimits(limitsFile('{"maxLoadPerCore": 1.5}'))).toEqual({
      maxLoadPerCore: 1.5,
      minAvailableMemory: 0.15,
    });
    expect(readLimits(limitsFile('{"minAvailableMemory": 0}'))).toEqual({
      maxLoadPerCore: 0.7,
      minAvailableMemory: 0,
    });
    expect(readLimits(limitsFile('{"maxLoadPerCore": 0, "minAvailableMemory": 1}'))).toEqual({
      maxLoadPerCore: 0,
      minAvailableMemory: 1,
    });
  });

  test("refuse a file that is not JSON of the two limits in range, naming it and why", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["not json", "it is not JSON"],
      ["[0.7]", "it holds no JSON object"],
      ["null", "it holds no JSON object"],
      ['{"maxLoad": 1}', "it holds the unknown key maxLoad"],
      ['{"maxLoadPerCore": "1"}', "its maxLoadPerCore is not a number of at least 0"],
      ['{"maxLoadPerCore": -1}', "its maxLoadPerCore is not a number of at least 0"],
      ['{"minAvailableMemory": 1.5}', "its minAvailableMemory is not a share from 0 to 1"],
    ];
    for (const [text, detail] of cases) {
      const path = limitsFile(text);
      expect(() => readLimits(path)).toThrow(
        expect.objectContaining({
          kind: "refusal",
          code: "limits_unreadable",
          meta: { path, detail: expect.stringContaining(detail) },
        }),
      );
    }
  });

  test("refuse a directory or a link to nothing as the file", () => {
    const dir = join(scratchDir(), "limits.json");
    mkdirSync(dir);
    expect(() => readLimits(dir)).toThrow(expect.objectContaining({ code: "limits_unreadable" }));
    const link = join(scratchDir(), "limits.json");
    symlinkSync(join(scratchDir(), "gone.json"), link);
    expect(() => readLimits(link)).toThrow(expect.objectContaining({ code: "limits_unreadable" }));
  });
});

describe("the busy check", () => {
  test("reads the limits before the machine, so an unreadable file refuses whatever the reading", () => {
    const limitsPath = limitsFile("not json");
    expect(() =>
      refuseWhileBusy(
        {
          limitsPath,
          readMachine: () => {
            throw new TypeError("read the machine");
          },
        },
        "task-a",
      ),
    ).toThrow(expect.objectContaining({ code: "limits_unreadable" }));
  });

  test("names the start to retry and where the owner sets the limits", () => {
    const limitsPath = limitsFile('{"minAvailableMemory": 0.5}');
    expect(() =>
      refuseWhileBusy(
        { limitsPath, readMachine: () => ({ loadAverage: 0, cores: 4, availableMemory: 0.25 }) },
        "task-a",
      ),
    ).toThrow(
      expect.objectContaining({
        message:
          "this machine is too busy to start another task: 25% of memory is available, below the limit of 50%",
        resolve: `start nothing now; retry agent-task start task-a --repo <path> --brief <file> [--project <id>] [--session <id>] once the machine is less busy; only the owner changes this machine's limits, in ${limitsPath}`,
      }),
    );
  });
});

describe("the machine's reading", () => {
  test("is this machine's 1-minute load average, its cores and the share of its memory available", () => {
    const reading = readMachine();
    expect(reading.cores).toBe(cpus().length);
    expect(reading.loadAverage).toBeGreaterThanOrEqual(0);
    expect(reading.availableMemory).toBeGreaterThan(0);
    expect(reading.availableMemory).toBeLessThanOrEqual(1);
  });
});
