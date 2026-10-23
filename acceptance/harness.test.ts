import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { binWith, removeScratchDirs, world } from "./harness";

afterEach(removeScratchDirs);

function executable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

function shimDir(root: string, tool: string): string {
  const launcher = executable(join(root, "launcher"), "mise");
  const shims = join(root, "shims");
  mkdirSync(shims);
  symlinkSync(launcher, join(shims, tool));
  return shims;
}

describe("binWith links each program past launcher shims", () => {
  test("links the first executable whose target is not a file named mise", () => {
    const w = world();
    const shims = shimDir(w.root, "jq");
    const real = executable(join(w.root, "real"), "jq");
    const bin = binWith(w, ["jq"], false, "bin", `${shims}:${join(w.root, "real")}`);
    expect(readlinkSync(join(bin, "jq"))).toBe(real);
  });

  test("refuses a program whose only hit is a shim", () => {
    const w = world();
    const shims = shimDir(w.root, "jq");
    expect(() => binWith(w, ["jq"], false, "bin", shims)).toThrow("jq is not on PATH");
  });
});
