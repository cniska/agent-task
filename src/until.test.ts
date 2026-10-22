import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeScratchDirs, scratchDir } from "./repo.test-support";
import { runCheck } from "./until";

afterAll(removeScratchDirs);

const TIMEOUT_MS = 5000;

function check(command: string, repo: string = scratchDir(), timeoutMs = TIMEOUT_MS) {
  return runCheck(command, repo, process.env, timeoutMs);
}

describe("a wait check", () => {
  test("is met on exit 0, unmet on exit 1 through 125, and failed on exit 126 and up, a signal or no shell", () => {
    expect(check("exit 0")).toBe("met");
    expect(check("exit 1")).toBe("unmet");
    expect(check("exit 125")).toBe("unmet");
    expect(check("exit 126")).toBe("failed");
    expect(check("no-such-command-for-agent-task")).toBe("failed");
    expect(check("kill -TERM $$")).toBe("failed");
  });

  test("fails when the repository is gone", () => {
    expect(check("exit 0", join(scratchDir(), "gone"))).toBe("failed");
  });

  test("times out at the limit passed in, long before the command ends", () => {
    const started = Date.now();
    expect(check("sleep 60", scratchDir(), 20)).toBe("timed_out");
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS);
  });

  test("runs the command in the repository, where a relative path resolves", () => {
    const repo = scratchDir();
    writeFileSync(join(repo, "released"), "");
    expect(check("test -f released", repo)).toBe("met");
    expect(check("test -f released", scratchDir())).toBe("unmet");
  });
});
