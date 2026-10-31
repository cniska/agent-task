import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProjectId, isTaskName, type ProjectId, type TaskName } from "./store";

const scratchDirs: string[] = [];

export function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-task-")));
  scratchDirs.push(dir);
  return dir;
}

export function removeScratchDirs(): void {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
}

function commit(dir: string, file: string): string {
  writeFileSync(join(dir, file), `${file}\n`);
  git(dir, ["add", file]);
  git(dir, ["commit", "-q", "-m", file]);
  return git(dir, ["rev-parse", "HEAD"]);
}

export function repo(): string {
  const dir = join(scratchDir(), "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  commit(dir, "first");
  return dir;
}

export function brief(dir: string, text = "# Brief\n"): string {
  const path = join(dir, "brief.md");
  writeFileSync(path, text);
  return path;
}

export function named(raw: string): TaskName {
  if (!isTaskName(raw)) throw new Error(`${raw} is no task name`);
  return raw;
}

export function projectNamed(raw: string): ProjectId {
  if (!isProjectId(raw)) throw new Error(`${raw} is no project id`);
  return raw;
}
