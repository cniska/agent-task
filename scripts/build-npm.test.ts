import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launcher, PLATFORMS, platformManifest, platformTarball, shimManifest } from "./build-npm";

describe("the npm packages", () => {
  test("name one package per release build, pinned to the shim's version", () => {
    expect(PLATFORMS.map(platformTarball)).toEqual([
      "agent-task-darwin-arm64.tar.gz",
      "agent-task-linux-x64.tar.gz",
    ]);
    expect(shimManifest("1.2.3", PLATFORMS)).toMatchObject({
      name: "@cniska/agent-task",
      version: "1.2.3",
      bin: { "agent-task": "bin/agent-task" },
      files: ["bin/agent-task"],
      optionalDependencies: {
        "@cniska/agent-task-darwin-arm64": "1.2.3",
        "@cniska/agent-task-linux-x64": "1.2.3",
      },
    });
    expect(shimManifest("1.2.3", PLATFORMS)).not.toHaveProperty("engines");
  });

  test("describe the shim with the README's tagline, so the package says what the README says", () => {
    const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8").split("\n");
    const quoted = readme.find((line) => line.startsWith("> ")) ?? "";
    expect(quoted).toStartWith("> Task tracking for coding agents:");
    expect(shimManifest("1.2.3", PLATFORMS).description).toBe(quoted.slice(2));
  });

  test("ship a POSIX shell launcher that names the release builds", () => {
    const script = launcher(PLATFORMS);
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("\nbuilds='darwin-arm64 linux-x64'\n");
    expect(script).not.toContain("__BUILDS__");
  });

  test("install a platform's binary only on that platform", () => {
    expect(platformManifest({ os: "linux", cpu: "x64" }, "1.2.3")).toMatchObject({
      name: "@cniska/agent-task-linux-x64",
      version: "1.2.3",
      os: ["linux"],
      cpu: ["x64"],
      files: ["agent-task"],
    });
  });

  test("name the repository trusted publishing proves the provenance of", () => {
    for (const manifest of [
      shimManifest("1.2.3", PLATFORMS),
      platformManifest({ os: "darwin", cpu: "arm64" }, "1.2.3"),
    ])
      expect(manifest).toMatchObject({
        repository: { type: "git", url: "git+https://github.com/cniska/agent-task.git" },
      });
  });
});
