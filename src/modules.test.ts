import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExportNamedDeclaration,
  Identifier,
  ImportDeclaration,
  Node,
  Statement,
  StringLiteral,
} from "@babel/types";
import { nodesOf, readsEnv } from "./syntax.test-support";

const SRC = import.meta.dir;

type Import = { readonly path: string; readonly typeOnly: boolean; readonly names: readonly string[] };

const ALL = "*";

const DEFAULT = "default";

function nameOf(name: Identifier | StringLiteral): string {
  return name.type === "Identifier" ? name.name : name.value;
}

function importedName(specifier: ImportDeclaration["specifiers"][number]): string {
  if (specifier.type === "ImportSpecifier") return nameOf(specifier.imported);
  return specifier.type === "ImportDefaultSpecifier" ? DEFAULT : ALL;
}

function exportedName(specifier: ExportNamedDeclaration["specifiers"][number]): string {
  if (specifier.type === "ExportSpecifier") return nameOf(specifier.local);
  return specifier.type === "ExportDefaultSpecifier" ? DEFAULT : ALL;
}

function loadedPath(node: Node): string | null {
  if (node.type !== "CallExpression") return null;
  const loads =
    node.callee.type === "Import" || (node.callee.type === "Identifier" && node.callee.name === "require");
  const [first] = node.arguments;
  if (!loads) return null;
  if (first?.type === "StringLiteral") return first.value;
  if (first?.type !== "TemplateLiteral" || first.expressions.length > 0) return null;
  return first.quasis[0]?.value.cooked ?? null;
}

function importOf(node: Node): Import | null {
  if (node.type === "ImportDeclaration") {
    const values = node.specifiers.filter(
      (specifier) => specifier.type !== "ImportSpecifier" || specifier.importKind !== "type",
    );
    const typeOnly = node.importKind === "type" || (node.specifiers.length > 0 && values.length === 0);
    return { path: node.source.value, typeOnly, names: values.map(importedName) };
  }
  if (node.type === "ExportNamedDeclaration" && node.source) {
    const values = node.specifiers.filter(
      (specifier) => specifier.type !== "ExportSpecifier" || specifier.exportKind !== "type",
    );
    const typeOnly = node.exportKind === "type" || values.length === 0;
    return { path: node.source.value, typeOnly, names: values.map(exportedName) };
  }
  if (node.type === "ExportAllDeclaration")
    return { path: node.source.value, typeOnly: node.exportKind === "type", names: [ALL] };
  if (node.type === "TSImportType") return { path: node.argument.value, typeOnly: true, names: [] };
  if (node.type === "TSImportEqualsDeclaration" && node.moduleReference.type === "TSExternalModuleReference")
    return {
      path: node.moduleReference.expression.value,
      typeOnly: node.importKind === "type",
      names: [ALL],
    };
  const path = loadedPath(node);
  return path === null ? null : { path, typeOnly: false, names: [ALL] };
}

function importsOf(text: string): readonly Import[] {
  return [...nodesOf(text)].flatMap((node) => importOf(node) ?? []);
}

const README = join(SRC, "README.md");

const MODULES_HEADING = "## Modules";

const MODULE_ROW = /^\| `([a-z][a-z-]*)` \|/;

function modulesOf(readme: string): readonly string[] {
  const lines = readme.split("\n");
  const start = lines.indexOf(MODULES_HEADING);
  if (start === -1) return [];
  const after = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines
    .slice(start + 1, after === -1 ? lines.length : after)
    .flatMap((line) => MODULE_ROW.exec(line)?.[1] ?? []);
}

const MODULES = modulesOf(readFileSync(README, "utf8"));

const ENTRY = "cli";

const PROCESS_RUNNERS = new Set(["git"]);

const TEST_PROCESS_RUNNERS = new Set(["cli.test.ts", "repo.test-support.ts"]);

const CLI_RUNNER = "cli.test.ts";

const CLI_ENTRY_LITERAL = `"${ENTRY}.ts"`;

const ERROR_CLASS = /Error$/;

const CODED_ERROR = "CodedError";

const BUILTIN_ERRORS = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const CODED_ERROR_FILE = "coded-error.ts";

const UNREACHABLE = "unreachable";

const PROCESS_PACKAGES = new Set(["node:child_process", "child_process"]);

const BUN_PACKAGE = "bun";

const BUN_SPAWNS = new Set(["spawn", "spawnSync", "$"]);

const TEST_FILE = /\.test(-support)?\.ts$|^test-env\.ts$/;

type Source = { readonly file: string; readonly text: string };

function allSources(): readonly Source[] {
  return readdirSync(SRC)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));
}

const moduleSources = () => allSources().filter(({ file }) => !TEST_FILE.test(file));

function ownerOf(base: string, modules: readonly string[] = MODULES): string | null {
  return modules.find((name) => base === name || base.startsWith(`${name}-`)) ?? null;
}

function importerOf(file: string): string | null {
  return TEST_FILE.test(file) && !file.endsWith(".test.ts")
    ? null
    : ownerOf(file.replace(/(\.test)?\.ts$/, ""));
}

function isPrivate(owner: string, base: string): boolean {
  return base !== owner || owner === ENTRY;
}

function boundaryBreaches(file: string, text: string): readonly string[] {
  const importer = importerOf(file);
  const paths = new Set(importsOf(text).map(({ path }) => path));
  return [...paths]
    .filter((path) => {
      if (!path.startsWith("./")) return false;
      const base = path.slice(2).replace(/\.(ts|js)$/, "");
      const owner = ownerOf(base);
      return owner !== null && owner !== importer && isPrivate(owner, base);
    })
    .map((path) => `${file} imports ${path}, another module's own file`);
}

function isBunSpawn(key: Node): boolean {
  return (
    (key.type === "Identifier" && BUN_SPAWNS.has(key.name)) ||
    (key.type === "StringLiteral" && BUN_SPAWNS.has(key.value))
  );
}

function isBun(node: Node | null | undefined): boolean {
  return node?.type === "Identifier" && node.name === "Bun";
}

function spawnsWithBun(node: Node): boolean {
  if (node.type === "MemberExpression" && isBun(node.object))
    return node.computed
      ? node.property.type === "StringLiteral" && isBunSpawn(node.property)
      : isBunSpawn(node.property);
  if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && isBun(node.init))
    return node.id.properties.some(
      (property) => property.type === "ObjectProperty" && isBunSpawn(property.key),
    );
  return false;
}

function startsProcess({ path, typeOnly, names }: Import): boolean {
  if (typeOnly) return false;
  if (PROCESS_PACKAGES.has(path)) return true;
  return (
    path === BUN_PACKAGE && names.some((name) => BUN_SPAWNS.has(name) || name === ALL || name === DEFAULT)
  );
}

function processBreaches(file: string, text: string): readonly string[] {
  const runner = ownerOf(file.replace(/\.ts$/, ""), [...PROCESS_RUNNERS]);
  if (TEST_PROCESS_RUNNERS.has(file) || runner !== null) return [];
  const starts = importsOf(text).some(startsProcess) || [...nodesOf(text)].some(spawnsWithBun);
  return starts ? [`${file} starts a process`] : [];
}

function isPlainError(node: Node | null | undefined): boolean {
  return node?.type === "Identifier" && ERROR_CLASS.test(node.name) && node.name !== CODED_ERROR;
}

function makesPlainError(node: Node): boolean {
  if (node.type === "NewExpression") return isPlainError(node.callee);
  if (node.type === "CallExpression")
    return node.callee.type === "Identifier" && BUILTIN_ERRORS.has(node.callee.name);
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression")
    return isPlainError(node.superClass);
  return false;
}

function errorBreaches(file: string, text: string): readonly string[] {
  if (file === CODED_ERROR_FILE) return [];
  return [...nodesOf(text)].some(makesPlainError) ? [`${file} makes an error that is not coded`] : [];
}

function isUnreachableCall(node: Node | null | undefined): boolean {
  return (
    node?.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === UNREACHABLE
  );
}

function callsUnreachable(statement: Statement | undefined): boolean {
  if (statement?.type === "ReturnStatement") return isUnreachableCall(statement.argument);
  if (statement?.type === "ExpressionStatement") return isUnreachableCall(statement.expression);
  return false;
}

function endsInUnreachable(node: Node): boolean {
  if (node.type !== "SwitchStatement") return true;
  const last = node.cases.at(-1);
  return last !== undefined && last.test === null && callsUnreachable(last.consequent[0]);
}

function switchBreaches(file: string, text: string): readonly string[] {
  return [...nodesOf(text)].every(endsInUnreachable)
    ? []
    : [`${file} has a switch that does not end in unreachable`];
}

function entryBreaches(file: string, text: string): readonly string[] {
  if (file === CLI_RUNNER || !text.includes(CLI_ENTRY_LITERAL)) return [];
  return [`${file} names ${CLI_ENTRY_LITERAL}, which only ${CLI_RUNNER} runs`];
}

const ENTRY_FILE = `${ENTRY}.ts`;

function envBreaches(file: string, text: string): readonly string[] {
  return file !== ENTRY_FILE && readsEnv(text) ? [`${file} reads the environment`] : [];
}

function unmapped(files: readonly string[], modules: readonly string[]): readonly string[] {
  return files.filter((file) => ownerOf(file.replace(/\.ts$/, ""), modules) === null);
}

describe("the modules", () => {
  test("another module or a test reaches a module only through its bare-named file, and never the entry", () => {
    expect(allSources().flatMap(({ file, text }) => boundaryBreaches(file, text))).toEqual([]);
  });

  test("only the entry reads the environment", () => {
    expect(moduleSources().flatMap(({ file, text }) => envBreaches(file, text))).toEqual([]);
  });

  test("only git starts a process, and among the tests only cli.test.ts and the repo fixtures", () => {
    expect(allSources().flatMap(({ file, text }) => processBreaches(file, text))).toEqual([]);
  });

  test("only cli.test.ts names the entry file it runs", () => {
    expect(allSources().flatMap(({ file, text }) => entryBreaches(file, text))).toEqual([]);
  });

  test("a module makes no error but a coded one", () => {
    expect(moduleSources().flatMap(({ file, text }) => errorBreaches(file, text))).toEqual([]);
  });

  test("every switch in a module ends in unreachable", () => {
    expect(moduleSources().flatMap(({ file, text }) => switchBreaches(file, text))).toEqual([]);
  });
});

describe("the module checks", () => {
  test("place every source file in a module src/README.md maps, and find every module's bare-named file", () => {
    const files = moduleSources().map(({ file }) => file);
    expect(MODULES).toContain(ENTRY);
    expect(unmapped(files, MODULES)).toEqual([]);
    expect(MODULES.filter((name) => !files.includes(`${name}.ts`))).toEqual([]);
  });

  test("read the modules from src/README.md's table, and catch a file it does not map", () => {
    const readme =
      "# src/\n\n| File | Holds |\n| `cli.ts` | x |\n\n## Modules\n\n| Prefix | Responsibility |\n| --- | --- |\n" +
      "| `cli` | x |\n| `coded-error` | x |\n\n## Where to start\n\n| `store` | x |\n";
    expect(modulesOf(readme)).toEqual(["cli", "coded-error"]);
    expect(modulesOf("# src/\n")).toEqual([]);
    expect(unmapped(["cli-commands.ts", "store.ts", "coded-error.ts"], modulesOf(readme))).toEqual([
      "store.ts",
    ]);
  });

  test("catch an environment read however it is written, outside the entry", () => {
    for (const text of [
      "const home = process.env.HOME;",
      'const home = process.env["HOME"];',
      'const home = process["env"].HOME;',
      "const home = process?.env.HOME;",
      "const { env } = process;",
      "const { env: vars } = process;",
      'import { env } from "node:process";',
      'import { env as vars } from "process";',
      'import process from "node:process";\nconst home = process.env.HOME;',
      "const home = Bun.env.HOME;",
      "const home = import.meta.env.HOME;",
    ]) {
      expect(envBreaches("store.ts", text)).toEqual(["store.ts reads the environment"]);
    }
    expect(envBreaches(ENTRY_FILE, "const home = process.env.HOME;")).toEqual([]);
    for (const text of [
      "const root = process.cwd();",
      "process.exitCode = 1;",
      "function run(env: Env) { return env.HOME; }",
      'import { argv } from "node:process";',
      "const { argv } = process;",
    ]) {
      expect(envBreaches("store.ts", text)).toEqual([]);
    }
  });

  test("catch an import of another module's own file, but not of its bare-named file or of its own", () => {
    const text =
      'import { a } from "./cli-contract";\nimport { b } from "./paths";\n' +
      'import { c } from "./coded-error";\nimport { d } from "node:fs";\n';
    expect(boundaryBreaches("tasks.ts", text)).toEqual([
      "tasks.ts imports ./cli-contract, another module's own file",
    ]);
    expect(boundaryBreaches("cli-commands.ts", text)).toEqual([]);
  });

  test("catch an import of the entry, even from another module's test", () => {
    expect(boundaryBreaches("tasks.test.ts", 'import "./cli";')).toEqual([
      "tasks.test.ts imports ./cli, another module's own file",
    ]);
    expect(boundaryBreaches("tasks.ts", 'import "./cli.js";')).toEqual([
      "tasks.ts imports ./cli.js, another module's own file",
    ]);
    expect(boundaryBreaches("cli.test.ts", 'import "./cli-output";')).toEqual([]);
  });

  test("hold a test support file to every module's bare-named file", () => {
    expect(boundaryBreaches("repo.test-support.ts", 'import { a } from "./cli-output";')).toEqual([
      "repo.test-support.ts imports ./cli-output, another module's own file",
    ]);
  });

  test("catch an import however it is written", () => {
    const breach = "tasks.ts imports ./cli-contract, another module's own file";
    for (const text of [
      'import type { Command } from "./cli-contract";',
      'import { type Command } from "./cli-contract";',
      'export type { Command } from "./cli-contract";',
      'export * from "./cli-contract";',
      'import type {\n  Command,\n} from\n  "./cli-contract";',
      'const contract = await import("./cli-contract");',
      "const contract = await import(`./cli-contract`);",
      'const contract = require("./cli-contract");',
      'let command: import("./cli-contract").Command;',
      'import contract = require("./cli-contract");',
    ]) {
      expect(boundaryBreaches("tasks.ts", text)).toEqual([breach]);
    }
  });

  test("catch a process started outside git", () => {
    for (const text of [
      'import { spawnSync } from "node:child_process";',
      'import { execFileSync } from "child_process";',
      'const child = await import("node:child_process");',
      'Bun.spawnSync(["ls"]);',
      'Bun.spawn(["ls"]);',
      "await Bun.$`ls`;",
      'import { $ } from "bun";',
      'import { spawnSync } from "bun";',
      'import * as bun from "bun";',
      'import "node:child_process";',
      'import child = require("node:child_process");',
      "const child = await import(`node:child_process`);",
      "const child = require(`child_process`);",
      'export { spawnSync } from "node:child_process";',
      'export { $ } from "bun";',
      'const { spawn } = Bun;\nspawn(["ls"]);',
      'Bun["spawn"](["ls"]);',
    ]) {
      expect(processBreaches("store.ts", text)).toEqual(["store.ts starts a process"]);
    }
    expect(processBreaches("git.ts", 'import { spawnSync } from "node:child_process";')).toEqual([]);
    expect(processBreaches("git-parse.ts", 'import { spawnSync } from "node:child_process";')).toEqual([]);
    expect(processBreaches("cli.test.ts", 'import { spawnSync } from "node:child_process";')).toEqual([]);
    expect(processBreaches("tasks.test.ts", 'import { spawnSync } from "node:child_process";')).toEqual([
      "tasks.test.ts starts a process",
    ]);
    for (const text of [
      'const help = "Bun.spawn(x)";',
      'import { Glob } from "bun";',
      'import type { SpawnSyncReturns } from "node:child_process";',
      'import { type SpawnSyncReturns } from "node:child_process";',
      'export type { SpawnSyncReturns } from "node:child_process";',
      'let child: import("node:child_process").ChildProcess;',
      "const { Glob } = Bun;",
      'Bun["file"]("x");',
    ]) {
      expect(processBreaches("store.ts", text)).toEqual([]);
    }
  });

  test("catch the entry file named outside cli.test.ts", () => {
    const text = `const CLI = resolve(import.meta.dir, ${CLI_ENTRY_LITERAL});`;
    expect(entryBreaches("tasks.test.ts", text)).toEqual([
      `tasks.test.ts names ${CLI_ENTRY_LITERAL}, which only cli.test.ts runs`,
    ]);
    expect(entryBreaches("cli.test.ts", text)).toEqual([]);
    expect(entryBreaches("tasks.test.ts", 'const runner = "cli.test.ts";')).toEqual([]);
  });

  test("catch an error that is not coded, however it is made", () => {
    for (const text of [
      'throw new Error("x");',
      'throw Error("x");',
      'throw new TypeError("x");',
      "class Refusal extends Error {}",
      "const Refusal = class extends Error {};",
    ]) {
      expect(errorBreaches("store.ts", text)).toEqual(["store.ts makes an error that is not coded"]);
    }
    for (const text of [
      'throw refuse("x", {});',
      "const e = new CodedError();",
      "if (error instanceof Error) throw error;",
      "writeError(null, error);",
    ]) {
      expect(errorBreaches("store.ts", text)).toEqual([]);
    }
    expect(errorBreaches("coded-error.ts", "class CodedError extends Error {}")).toEqual([]);
  });

  test("catch a switch that does not end in unreachable", () => {
    for (const text of [
      'function f(x) { switch (x) { case "a": return 1; } }',
      'function f(x) { switch (x) { case "a": return unreachable(x); } }',
      'function f(x) { switch (x) { case "a": return 1; default: return 0; } }',
      'function f(x) { switch (x) { default: return unreachable(x); case "a": return 1; } }',
      'function f(x) { switch (x) { case "a": return 1; default: log(x); return unreachable(x); } }',
    ]) {
      expect(switchBreaches("tasks.ts", text)).toEqual([
        "tasks.ts has a switch that does not end in unreachable",
      ]);
    }
    for (const text of [
      'function f(x) { switch (x) { case "a": return 1; default: return unreachable(x); } }',
      'function f(x) { switch (x) { case "a": return; default: unreachable(x); } }',
    ]) {
      expect(switchBreaches("tasks.ts", text)).toEqual([]);
    }
  });
});
