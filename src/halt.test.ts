import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { haltedNow, liftHalt, raiseHalt, readHalt } from "./halt";
import { removeScratchDirs, scratchDir } from "./repo.test-support";

afterAll(removeScratchDirs);

const RAISED_AT = new Date("2026-10-31T10:00:00.000Z");

const LATER = new Date("2026-10-31T11:00:00.000Z");

const OWNER_RESUMES =
  "make no change: state your report and stop; only the owner lifts the halt, with agent-task resume";

function haltFile(): string {
  return join(scratchDir(), "agent-task", "halt.json");
}

function written(text: string): string {
  const path = haltFile();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe("the halt", () => {
  test("reads as none while no halt is recorded, and halted says so", () => {
    const path = haltFile();
    expect(readHalt(path)).toEqual({ state: "none" });
    expect(haltedNow(path)).toEqual({ state: "none" });
  });

  test("is raised with its reason and time, creating its directory and leaving no other file", () => {
    const path = haltFile();
    const raised = {
      state: "raised",
      reason: "a flaw in the workflow",
      raised: "2026-10-31T10:00:00.000Z",
    } as const;
    expect(raiseHalt(path, "a flaw in the workflow", RAISED_AT)).toEqual(raised);
    expect(readHalt(path)).toEqual(raised);
    expect(readdirSync(join(path, ".."))).toEqual(["halt.json"]);
  });

  test("raised again keeps the first reason and time", () => {
    const path = haltFile();
    const first = raiseHalt(path, "first", RAISED_AT);
    expect(raiseHalt(path, "second", LATER)).toEqual(first);
    expect(readHalt(path)).toEqual(first);
  });

  test("refuses halted while raised, naming the reason and the owner's resume", () => {
    const path = haltFile();
    raiseHalt(path, "a flaw in the workflow", RAISED_AT);
    expect(() => haltedNow(path)).toThrow(
      expect.objectContaining({
        kind: "refusal",
        code: "halted",
        message:
          "all agent work on this machine is halted, since 2026-10-31T10:00:00.000Z: a flaw in the workflow",
        meta: { state: "raised", reason: "a flaw in the workflow", raised: "2026-10-31T10:00:00.000Z" },
        resolve: OWNER_RESUMES,
      }),
    );
  });

  test("counts a record it cannot read as raised: not JSON, the wrong shape, an unknown key, a blank reason, a directory or a link to nothing", () => {
    const unreadable = [
      written("half a reco"),
      written("[]"),
      written('{"reason":"x","raised":"t","by":"me"}'),
      written('{"reason":" ","raised":"t"}'),
      written('{"reason":"x","raised":1}'),
    ];
    const directory = haltFile();
    mkdirSync(directory, { recursive: true });
    const dangling = haltFile();
    mkdirSync(join(dangling, ".."), { recursive: true });
    symlinkSync(join(dangling, "..", "nowhere.json"), dangling);
    for (const path of [...unreadable, directory, dangling]) {
      expect(readHalt(path)).toMatchObject({ state: "unreadable", path });
      expect(() => haltedNow(path)).toThrow(
        expect.objectContaining({ code: "halted", meta: expect.objectContaining({ state: "unreadable" }) }),
      );
      expect(raiseHalt(path, "another", LATER)).toMatchObject({ state: "unreadable" });
    }
  });

  test("is lifted by resume, which returns it as it was, then none, and lifts an unreadable record too", () => {
    const path = haltFile();
    const raised = raiseHalt(path, "a flaw in the workflow", RAISED_AT);
    expect(liftHalt(path)).toEqual(raised);
    expect(readHalt(path)).toEqual({ state: "none" });
    expect(liftHalt(path)).toEqual({ state: "none" });
    const garbled = written("half");
    expect(liftHalt(garbled)).toMatchObject({ state: "unreadable" });
    expect(readHalt(garbled)).toEqual({ state: "none" });
  });

  test("refuses to lift a record it cannot remove, which stays raised", () => {
    const path = haltFile();
    mkdirSync(path, { recursive: true });
    expect(() => liftHalt(path)).toThrow(
      expect.objectContaining({ code: "halt_unremovable", meta: expect.objectContaining({ path }) }),
    );
    expect(readHalt(path)).toMatchObject({ state: "unreadable" });
  });
});
