import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { version } from "../package.json";
import { ownerEnv } from "../src/test-env";

const LAUNCHER = resolve(import.meta.dir, "..", "bin", "agent-task");

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDataHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-task-data-")));
  scratch.push(dir);
  return dir;
}

function ownerEnvWith(dataHome: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...ownerEnv, XDG_DATA_HOME: dataHome };
  delete env.MISE_DATA_DIR;
  return env;
}

describe("the source launcher", () => {
  test("finds bun through mise when XDG_DATA_HOME points at an empty directory", () => {
    const run = spawnSync(LAUNCHER, ["--version"], {
      encoding: "utf8",
      env: ownerEnvWith(scratchDataHome()),
    });
    expect([run.status, run.stdout, run.stderr]).toEqual([0, `${version}\n`, ""]);
  });
});
