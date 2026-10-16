import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const GUARDED_DIRS = ["src", "acceptance", "scripts", "bin", "plugin", "npm", "docs"];

const SELF = "scripts/standalone.test.ts";

const WORKFLOWS = ".github/workflows";

const INSTALLED_WORKFLOW = "# agent-gate:";

const GUARDED_FILES = ["SPEC.md", "README.md"];

const README = "README.md";

const CONTRIBUTOR_SECTION = "## Development";

const SUGGESTED = /^(cniska-skills|agent-skills)$/;

const OTHER_TOOL = /\b(cniska-(skills|record|gates|worktree)|agent-(record|gates|skills|worktree|ops))\b/g;

type Guarded = { readonly path: string; readonly text: string };

function contributorLines(text: string): ReadonlySet<number> {
  const lines = text.split("\n");
  const start = lines.indexOf(CONTRIBUTOR_SECTION);
  if (start === -1) return new Set();
  const after = lines.findIndex((line, index) => index > start && /^## /.test(line));
  const end = after === -1 ? lines.length : after;
  return new Set(Array.from({ length: end - start }, (_, offset) => start + offset + 1));
}

function namings({ path, text }: Guarded): readonly string[] {
  const suggesting = path === README ? contributorLines(text) : new Set<number>();
  return text.split("\n").flatMap((line, index) => {
    const at = index + 1;
    return [...line.matchAll(OTHER_TOOL)]
      .filter(([match]) => !(suggesting.has(at) && SUGGESTED.test(match)))
      .map(([match]) => `${path}:${at} names another tool: ${match}`);
  });
}

function filesUnder(dir: string): readonly string[] {
  return [...new Bun.Glob("**/*").scanSync({ cwd: join(ROOT, dir), dot: true })].map((path) =>
    join(dir, path),
  );
}

function ownWorkflow({ text }: Guarded): boolean {
  return !text.startsWith(INSTALLED_WORKFLOW);
}

function read(path: string): Guarded {
  return { path, text: readFileSync(join(ROOT, path), "utf8") };
}

function guardedFiles(): readonly Guarded[] {
  const paths = [...GUARDED_DIRS.flatMap(filesUnder), ...GUARDED_FILES].filter((path) => path !== SELF);
  return [...paths.map(read), ...filesUnder(WORKFLOWS).map(read).filter(ownWorkflow)].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

describe("the repo stands alone", () => {
  test("names no other tool", () => {
    expect(guardedFiles().flatMap(namings)).toEqual([]);
  });

  test("lets only the README's contributor section suggest cniska-skills", () => {
    const text = `# x\n\nUse cniska-skills.\n\n${CONTRIBUTOR_SECTION}\n\nTry cniska-skills or agent-gates.\n\n## Next\n\ncniska-skills`;
    expect(namings({ path: README, text })).toEqual([
      "README.md:3 names another tool: cniska-skills",
      "README.md:7 names another tool: agent-gates",
      "README.md:11 names another tool: cniska-skills",
    ]);
    expect(namings({ path: "SPEC.md", text })).toHaveLength(4);
  });

  test("guards the sources, the spec, the README and the workflows it owns, but not itself or a workflow another tool installs", () => {
    const paths = guardedFiles().map(({ path }) => path);
    expect(paths).toContain("src/cli.ts");
    expect(paths).toContain("acceptance/harness.ts");
    expect(paths).toContain("bin/agent-task");
    expect(paths).toContain("plugin/hooks/hooks.json");
    expect(paths).toContain("npm/agent-task");
    expect(paths).toContain("docs/releasing.md");
    expect(paths).toContain(".github/workflows/release.yml");
    expect(paths).toContain("SPEC.md");
    expect(paths).toContain("README.md");
    expect(paths).toContain(".github/workflows/check.yml");
    expect(paths).not.toContain(SELF);
    expect(ownWorkflow({ path: "x.yml", text: "# agent-gate:made-up:1\nname: X\n" })).toBe(false);
    expect(ownWorkflow({ path: "x.yml", text: "name: X\n# agent-gate:made-up:1\n" })).toBe(true);
  });

  test("names another tool wherever it stands, its own names freely", () => {
    const text = "agent-task and cniska-task\nagent-worktree, cniska-gates, agent-ops";
    expect(namings({ path: "src/x.ts", text })).toEqual([
      "src/x.ts:2 names another tool: agent-worktree",
      "src/x.ts:2 names another tool: cniska-gates",
      "src/x.ts:2 names another tool: agent-ops",
    ]);
  });
});
