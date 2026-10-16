import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { faults, refusals } from "./coded-error";

export type ProcessEnv = Readonly<Record<string, string | undefined>>;

const refuse = refusals<{
  readonly not_a_checkout: { readonly path: string; readonly candidate: string | null };
}>({
  not_a_checkout: {
    message: ({ path, candidate }) =>
      candidate === null
        ? `${path} is not inside a git checkout`
        : `${path} is in a repository whose main working tree git cannot confirm (it would be ${candidate}): a submodule, a separate git dir or a bare repository`,
    resolve: () => "pass the path of a git checkout with its own .git directory, or one of its worktrees",
  },
});

const fault = faults<{
  readonly git_unavailable: { readonly detail: string };
}>({
  git_unavailable: {
    message: ({ detail }) => `git could not run: ${detail}`,
    resolve: () => "stop and hand this error to the owner: git must be installed and on PATH",
  },
});

type GitRun = { readonly ok: boolean; readonly out: string };

function git(dir: string | null, args: readonly string[], processEnv: ProcessEnv): GitRun {
  const run = spawnSync("git", dir === null ? [...args] : ["-C", dir, ...args], {
    env: processEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: Number.POSITIVE_INFINITY,
  });
  if (run.error) throw fault("git_unavailable", { detail: run.error.message });
  return { ok: run.status === 0, out: run.stdout.trim() };
}

function absoluteRevParse(dir: string, flag: string, processEnv: ProcessEnv): string | null {
  const run = git(dir, ["rev-parse", "--path-format=absolute", flag], processEnv);
  return run.ok ? realpathSync(run.out) : null;
}

export function mainWorkingTree(path: string, processEnv: ProcessEnv): string {
  const common = absoluteRevParse(path, "--git-common-dir", processEnv);
  if (common === null) throw refuse("not_a_checkout", { path, candidate: null });
  const candidate = dirname(common);
  const toplevel = absoluteRevParse(candidate, "--show-toplevel", processEnv);
  const confirmed =
    toplevel === candidate && absoluteRevParse(candidate, "--git-common-dir", processEnv) === common;
  if (!confirmed) throw refuse("not_a_checkout", { path, candidate });
  return candidate;
}

export function blobSha(file: string, processEnv: ProcessEnv): string | null {
  const run = git(null, ["hash-object", "--no-filters", "--", file], processEnv);
  return run.ok ? run.out : null;
}
