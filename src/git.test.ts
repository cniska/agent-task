import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blobSha, mainWorkingTree } from "./git";
import { git, removeScratchDirs, repo, scratchDir } from "./repo.test-support";

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
