import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blobSha, commitOf, isAncestor, landingBranch, mainWorkingTree } from "./git";
import { commit, git, removeScratchDirs, repo, scratchDir, withOrigin } from "./repo.test-support";

afterAll(removeScratchDirs);

const processEnv = process.env;

describe("the main working tree", () => {
  test("is the repository's own checkout, from it, a directory inside it and a linked worktree", () => {
    const main = repo();
    mkdirSync(join(main, "sub"));
    const linked = join(scratchDir(), "linked");
    git(main, ["worktree", "add", "-q", "-b", "topic", linked]);
    for (const path of [main, join(main, "sub"), linked])
      expect(mainWorkingTree(path, processEnv)).toBe(main);
  });

  test("is refused for a path outside git, a missing path, a file, a bare repository, a submodule and a separate git dir", () => {
    const outside = scratchDir();
    const file = join(repo(), "file");
    writeFileSync(file, "x\n");
    const bare = join(scratchDir(), "bare.git");
    git(outside, ["init", "-q", "--bare", bare]);
    const superproject = repo();
    const sub = repo();
    git(superproject, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod"]);
    const separate = join(scratchDir(), "separate");
    git(outside, ["init", "-q", "--separate-git-dir", join(scratchDir(), "gitdir"), separate]);
    for (const path of [outside, join(outside, "missing"), file, bare, join(superproject, "mod"), separate])
      expect(() => mainWorkingTree(path, processEnv)).toThrow(
        expect.objectContaining({ code: "not_a_checkout" }),
      );
  });
});

describe("a blob sha", () => {
  test("is git's hash of the file's bytes, inside a repository or not", () => {
    const dir = scratchDir();
    const file = join(dir, "brief.md");
    writeFileSync(file, "hello\n");
    expect(blobSha(file, processEnv)).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  test("is null for a missing file, a directory and a file that cannot be read", () => {
    const dir = scratchDir();
    const unreadable = join(dir, "unreadable.md");
    writeFileSync(unreadable, "hello\n");
    chmodSync(unreadable, 0o000);
    for (const path of [join(dir, "missing", "brief.md"), dir, unreadable])
      expect(blobSha(path, processEnv)).toBeNull();
  });
});

describe("landing", () => {
  test("names origin's default branch and judges reachability from it after a fetch", () => {
    const main = repo();
    const origin = withOrigin(main);
    const landed = git(main, ["rev-parse", "HEAD"]);
    const other = join(scratchDir(), "other");
    git(scratchDir(), ["clone", "-q", origin, other]);
    const pushedElsewhere = commit(other, "elsewhere");
    git(other, ["push", "-q", "origin", "main"]);
    git(main, ["checkout", "-q", "-b", "topic"]);
    const unpushed = commit(main, "topic");
    const landing = landingBranch(main, processEnv);
    expect(landing).toEqual({ ref: "refs/remotes/origin/main", branch: "origin/main" });
    const reachable = (sha: string) => isAncestor(main, sha, landing.ref, processEnv);
    expect([reachable(landed), reachable(pushedElsewhere), reachable(unpushed)]).toEqual([true, true, false]);
  });

  test("reads origin's default branch from origin, whatever it is named", () => {
    const main = repo();
    const origin = withOrigin(main);
    git(main, ["push", "-q", "origin", "main:trunk"]);
    git(origin, ["symbolic-ref", "HEAD", "refs/heads/trunk"]);
    expect(landingBranch(main, processEnv).branch).toBe("origin/trunk");
  });

  test("refuses a repository with no origin, an origin that cannot be reached, and one whose HEAD is no branch", () => {
    const none = repo();
    expect(() => landingBranch(none, processEnv)).toThrow(expect.objectContaining({ code: "no_origin" }));
    const gone = repo();
    git(gone, ["remote", "add", "origin", join(scratchDir(), "missing.git")]);
    expect(() => landingBranch(gone, processEnv)).toThrow(
      expect.objectContaining({ code: "remote_unreachable" }),
    );
    const headless = repo();
    const origin = withOrigin(headless);
    git(origin, ["symbolic-ref", "HEAD", "refs/heads/nothing"]);
    expect(() => landingBranch(headless, processEnv)).toThrow(
      expect.objectContaining({ code: "no_default_branch" }),
    );
  });

  test("resolves a sha to its full commit, and an unknown one to null", () => {
    const main = repo();
    const head = git(main, ["rev-parse", "HEAD"]);
    expect(commitOf(main, head.slice(0, 10), processEnv)).toBe(head);
    expect(commitOf(main, "0".repeat(40), processEnv)).toBeNull();
    expect(commitOf(main, "--all", processEnv)).toBeNull();
  });
});
