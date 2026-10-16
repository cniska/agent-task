import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { BUG, faults, refusals } from "./coded-error";

const TIMED_OUT = "ETIMEDOUT";

function systemErrorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

export type ProcessEnv = Readonly<Record<string, string | undefined>>;

const REMOTE = "origin";

const REMOTE_TIMEOUT_MS = 60_000;

const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0" };

const HEAD_SYMREF = /^ref: refs\/heads\/(\S+)\tHEAD$/m;

const NOT_ANCESTOR = 1;

const refuse = refusals<{
  readonly not_a_checkout: { readonly path: string; readonly candidate: string | null };
  readonly no_origin: { readonly repo: string };
  readonly remote_unreachable: { readonly repo: string; readonly command: string; readonly detail: string };
  readonly no_default_branch: { readonly repo: string };
}>({
  not_a_checkout: {
    message: ({ path, candidate }) =>
      candidate === null
        ? `${path} is not inside a git checkout`
        : `${path} is in a repository whose main working tree git cannot confirm (it would be ${candidate}): a submodule, a separate git dir or a bare repository`,
    resolve: () => "pass the path of a git checkout with its own .git directory, or one of its worktrees",
  },
  no_origin: {
    message: ({ repo }) => `${repo} has no remote named origin`,
    resolve: ({ repo }) =>
      `add the remote the work lands on as origin in ${repo}, then run the command again`,
  },
  remote_unreachable: {
    message: ({ command, detail }) => `${command} did not finish: ${detail}`,
    resolve: () => "make origin reachable without a prompt, then run the command again",
  },
  no_default_branch: {
    message: ({ repo }) => `origin of ${repo} names no default branch (its HEAD is no branch)`,
    resolve: () => "set origin's default branch, then run the command again",
  },
});

const fault = faults<{
  readonly git_unavailable: { readonly detail: string };
  readonly git_failed: { readonly command: string; readonly detail: string };
}>({
  git_unavailable: {
    message: ({ detail }) => `git could not run: ${detail}`,
    resolve: () => "stop and hand this error to the owner: git must be installed and on PATH",
  },
  git_failed: {
    message: ({ command, detail }) => `${command} failed: ${detail}`,
    resolve: () => BUG,
  },
});

type GitRun = { readonly status: number | null; readonly out: string; readonly err: string };

type Spawned = GitRun & { readonly timedOut: boolean };

function spawnGit(
  dir: string | null,
  args: readonly string[],
  processEnv: ProcessEnv,
  timeout: number | undefined,
): Spawned {
  const run = spawnSync("git", dir === null ? [...args] : ["-C", dir, ...args], {
    env: processEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: Number.POSITIVE_INFINITY,
    timeout,
    killSignal: "SIGKILL",
  });
  const timedOut = systemErrorCode(run.error) === TIMED_OUT;
  if (run.error && !timedOut) throw fault("git_unavailable", { detail: run.error.message });
  return { status: run.status, out: run.stdout.trim(), err: run.stderr.trim(), timedOut };
}

function git(
  dir: string | null,
  args: readonly string[],
  processEnv: ProcessEnv,
): GitRun & { readonly ok: boolean } {
  const run = spawnGit(dir, args, processEnv, undefined);
  return { ...run, ok: run.status === 0 };
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

function remoteOutput(repo: string, args: readonly string[], processEnv: ProcessEnv): string {
  const run = spawnGit(repo, args, { ...processEnv, ...NO_PROMPT }, REMOTE_TIMEOUT_MS);
  const command = `git ${args.join(" ")}`;
  if (run.timedOut)
    throw refuse("remote_unreachable", {
      repo,
      command,
      detail: `no answer in ${REMOTE_TIMEOUT_MS / 1000} s`,
    });
  if (run.status !== 0) throw refuse("remote_unreachable", { repo, command, detail: run.err });
  return run.out;
}

export type Landing = { readonly ref: string; readonly branch: string };

export function requireOrigin(repo: string, processEnv: ProcessEnv): void {
  if (!git(repo, ["config", "--get", `remote.${REMOTE}.url`], processEnv).ok)
    throw refuse("no_origin", { repo });
}

export function landingBranch(repo: string, processEnv: ProcessEnv): Landing {
  requireOrigin(repo, processEnv);
  const branch = HEAD_SYMREF.exec(
    remoteOutput(repo, ["ls-remote", "--symref", REMOTE, "HEAD"], processEnv),
  )?.[1];
  if (branch === undefined) throw refuse("no_default_branch", { repo });
  const tracking = `refs/remotes/${REMOTE}/${branch}`;
  remoteOutput(repo, ["fetch", "--no-tags", REMOTE, `+refs/heads/${branch}:${tracking}`], processEnv);
  return { ref: tracking, branch: `${REMOTE}/${branch}` };
}

export type Sha = string & { readonly __brand: "Sha" };

const SHA = /^[0-9a-f]{4,40}$/;

export function isSha(value: string): value is Sha {
  return SHA.test(value);
}

export function commitOf(repo: string, sha: Sha, processEnv: ProcessEnv): string | null {
  const run = git(
    repo,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`],
    processEnv,
  );
  return run.ok && run.out.startsWith(sha) ? run.out : null;
}

export function isAncestor(repo: string, commit: string, ref: string, processEnv: ProcessEnv): boolean {
  const args = ["merge-base", "--is-ancestor", commit, ref];
  const run = git(repo, args, processEnv);
  if (run.ok) return true;
  if (run.status === NOT_ANCESTOR) return false;
  throw fault("git_failed", { command: `git ${args.join(" ")}`, detail: run.err });
}
