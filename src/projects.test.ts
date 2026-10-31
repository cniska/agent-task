import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { liftHalt, raiseHalt } from "./halt";
import { addProject, dropProject, listProjects, type ProjectContext } from "./projects";
import { named, projectNamed, removeScratchDirs, repo, scratchDir } from "./repo.test-support";
import { heldProject, insertQueued, openStore } from "./store";

afterAll(removeScratchDirs);

function context(): ProjectContext {
  const dir = scratchDir();
  return {
    store: openStore(join(dir, "tasks.db"), 0),
    haltPath: join(dir, "halt.json"),
    processEnv: process.env,
  };
}

function briefs(dir: string): string {
  const path = join(dir, "briefs");
  mkdirSync(path);
  return path;
}

describe("project add", () => {
  test("records a project with the repository's main working tree and the directory's real path, and replaces it on its id", () => {
    const ctx = context();
    const dir = repo();
    mkdirSync(join(dir, "sub"));
    const home = briefs(dir);
    expect(
      addProject(ctx, { id: "site", name: "The site", repo: join(dir, "sub"), dir: join(home, ".") }),
    ).toEqual({
      id: projectNamed("site"),
      name: "The site",
      repo: dir,
      dir: home,
    });
    const other = repo();
    expect(addProject(ctx, { id: "site", name: "The new site", repo: other, dir: home })).toEqual({
      id: projectNamed("site"),
      name: "The new site",
      repo: other,
      dir: home,
    });
    expect(listProjects(ctx)).toEqual([
      { id: projectNamed("site"), name: "The new site", repo: other, dir: home },
    ]);
  });

  test("refuses an invalid id, a path outside git and a directory that is not one, recording nothing", () => {
    const ctx = context();
    const dir = repo();
    const home = briefs(dir);
    const file = join(dir, "file.md");
    writeFileSync(file, "x\n");
    expect(() => addProject(ctx, { id: "The_Site", name: "x", repo: dir, dir: home })).toThrow(
      expect.objectContaining({ code: "invalid_project", meta: { id: "The_Site" } }),
    );
    expect(() => addProject(ctx, { id: "site", name: "x", repo: scratchDir(), dir: home })).toThrow(
      expect.objectContaining({ code: "not_a_checkout" }),
    );
    for (const missing of [file, join(dir, "gone")])
      expect(() => addProject(ctx, { id: "site", name: "x", repo: dir, dir: missing })).toThrow(
        expect.objectContaining({ code: "dir_missing", meta: { dir: missing } }),
      );
    expect(listProjects(ctx)).toEqual([]);
  });
});

describe("project remove", () => {
  test("removes a project no task belongs to, returning it, refuses one a task belongs to naming map and done, and an unknown one", () => {
    const ctx = context();
    const dir = repo();
    const project = addProject(ctx, { id: "site", name: "The site", repo: dir, dir });
    insertQueued(ctx.store, {
      name: named("task-a"),
      project: project.id,
      repo: dir,
      goal: "g",
      plan: null,
      priority: null,
      waits: null,
      added: "2026-10-16T10:00:00.000Z",
      after: [],
      until: null,
    });
    expect(() => dropProject(ctx, "site")).toThrow(
      expect.objectContaining({
        code: "project_in_use",
        meta: { id: "site", tasks: ["task-a"] },
        resolve:
          "agent-task map task-a --project <id> or agent-task done task-a, then remove the project again",
      }),
    );
    expect(heldProject(ctx.store, project.id)).toEqual(project);
    ctx.store.db.run("DELETE FROM tasks");
    expect(dropProject(ctx, "site")).toEqual(project);
    expect(listProjects(ctx)).toEqual([]);
    expect(() => dropProject(ctx, "site")).toThrow(
      expect.objectContaining({ code: "unknown_project", meta: { id: "site" } }),
    );
  });
});

describe("a halt", () => {
  test("refuses project add and remove while raised, recording nothing, and admits them once lifted", () => {
    const ctx = context();
    const dir = repo();
    addProject(ctx, { id: "kept", name: "Kept", repo: dir, dir });
    raiseHalt(ctx.haltPath, "a flaw", new Date("2026-10-16T12:00:00.000Z"));
    const halted = expect.objectContaining({ code: "halted" });
    expect(() => addProject(ctx, { id: "site", name: "The site", repo: dir, dir })).toThrow(halted);
    expect(() => dropProject(ctx, "kept")).toThrow(halted);
    expect(listProjects(ctx).map(({ id }) => id)).toEqual([projectNamed("kept")]);
    liftHalt(ctx.haltPath);
    expect(dropProject(ctx, "kept")).toMatchObject({ id: "kept" });
  });
});
