import { describe, expect, test } from "bun:test";
import { refuseUngated, ungatedChecks } from "./gate";

describe("ungatedChecks", () => {
  test("finds a mise run of a task named, or first named, for a check", () => {
    for (const [command, check] of [
      ["mise run check", "mise run check"],
      ["mise run verify", "mise run verify"],
      ["mise run verify:api", "mise run verify:api"],
      ["mise run test:int", "mise run test:int"],
      ["mise r lint", "mise r lint"],
      ["mise run -j 4 typecheck", "mise run -j 4 typecheck"],
      ["mise run build", "mise run build"],
    ] as const) {
      expect(ungatedChecks(command)).toEqual([check]);
    }
  });

  test("finds the test runners and builds started directly", () => {
    for (const command of [
      "bun test",
      "bun test src/a.test.ts",
      "bun run check",
      "flutter test",
      "dart test",
      "busted spec",
      "cargo test --workspace",
      "xcodebuild -scheme App test",
      "/usr/bin/xcodebuild build",
      "npm test",
      "npm run test:unit",
      "pnpm test",
      "pnpm run lint",
      "yarn test",
      "yarn typecheck",
    ]) {
      expect(ungatedChecks(command)).toEqual([command]);
    }
  });

  test("finds a check anywhere in a compound command, behind a cd, a wrapper or an assignment", () => {
    expect(ungatedChecks("cd app && mise run check")).toEqual(["mise run check"]);
    expect(ungatedChecks("git status; bun test | tail -5")).toEqual(["bun test"]);
    expect(ungatedChecks("ls\nflutter test")).toEqual(["flutter test"]);
    expect(ungatedChecks("(cd app; cargo test)")).toEqual(["cargo test"]);
    expect(ungatedChecks("CI=1 mise run test 2>&1 >out.txt")).toEqual(["mise run test"]);
    expect(ungatedChecks("bun test <<< 'input'")).toEqual(["bun test"]);
    expect(ungatedChecks("bun test >> log < /dev/null")).toEqual(["bun test"]);
    expect(ungatedChecks("env -i FOO=1 bun test")).toEqual(["bun test"]);
    expect(ungatedChecks("timeout 600 nice -n 10 mise run check")).toEqual(["mise run check"]);
    expect(ungatedChecks("mise exec -- cargo test")).toEqual(["cargo test"]);
    expect(ungatedChecks("if true; then mise run lint; fi")).toEqual(["mise run lint"]);
    expect(ungatedChecks("{ bun test; } &")).toEqual(["bun test"]);
    expect(ungatedChecks("ls & bun test")).toEqual(["bun test"]);
  });

  test("follows command substitutions and a shell's -c script", () => {
    expect(ungatedChecks("echo $(mise run check)")).toEqual(["mise run check"]);
    expect(ungatedChecks('echo "result: $(bun test)"')).toEqual(["bun test"]);
    expect(ungatedChecks("echo `cargo test`")).toEqual(["cargo test"]);
    expect(ungatedChecks("bash -lc 'cd app && mise run verify'")).toEqual(["mise run verify"]);
    expect(ungatedChecks('sh -c "flutter test"')).toEqual(["flutter test"]);
  });

  test("leaves agent-task check's argument alone, but not a substitution the outer shell expands in it", () => {
    expect(ungatedChecks("agent-task check 'cd app && mise run check'")).toEqual([]);
    expect(ungatedChecks("cd app && agent-task check 'mise run check'")).toEqual([]);
    expect(ungatedChecks("FOO=1 agent-task check 'bun test'")).toEqual([]);
    expect(ungatedChecks("agent-task check 'true' && mise run check")).toEqual(["mise run check"]);
    expect(ungatedChecks('agent-task check "$(mise run check)"')).toEqual(["mise run check"]);
    expect(ungatedChecks("agent-task check `bun test`")).toEqual(["bun test"]);
  });

  test("passes commands that run no check, a dev server and a watcher among them", () => {
    for (const command of [
      "ls -la",
      "git commit -m 'bun test'",
      'grep -rn "mise run check" docs',
      "echo bun test",
      "mise run dev",
      "mise exec -- ./scripts/test-stack.sh",
      "mise run test:watch",
      "bun test --watch",
      "bun run dev",
      "npm install",
      "flutter run",
      "# mise run check",
      "mise install",
      "test -f x",
      "",
    ]) {
      expect(ungatedChecks(command)).toEqual([]);
    }
  });

  test("reads a here-document's body as data, following its substitutions only when its delimiter is unquoted", () => {
    const message = "feat: add the gate\n\nmise run check passes, and it's green\n";
    expect(ungatedChecks(`git commit -m "$(cat <<'EOF'\n${message}EOF\n)"`)).toEqual([]);
    expect(ungatedChecks(`cat > ci.sh <<EOF\nbun test\nEOF\nls`)).toEqual([]);
    expect(ungatedChecks(`cat <<-"EOF"\n\tbun test $(cargo test)\n\tEOF\nmise run lint`)).toEqual([
      "mise run lint",
    ]);
    expect(ungatedChecks(`cat <<EOF\nresult: $(cargo test)\nEOF`)).toEqual(["cargo test"]);
    expect(ungatedChecks(`cat <<EOF\nbun test`)).toEqual([]);
  });

  test("reads a command with an unclosed quote or substitution to its end", () => {
    expect(ungatedChecks("echo 'oops && bun test")).toEqual([]);
    expect(ungatedChecks('echo "$(bun test')).toEqual(["bun test"]);
    expect(ungatedChecks("echo `cargo test")).toEqual(["cargo test"]);
  });
});

describe("refuseUngated", () => {
  test("prints gated for a command that runs no ungated check", () => {
    expect(refuseUngated("agent-task check 'mise run check'")).toEqual({ gated: true });
  });

  test("refuses check_ungated naming the checks and the agent-task check command, quoted for the shell", () => {
    expect(() => refuseUngated("cd 'my app' && mise run check")).toThrow(
      expect.objectContaining({
        kind: "refusal",
        code: "check_ungated",
        meta: { command: "cd 'my app' && mise run check", checks: ["mise run check"] },
        resolve: expect.stringContaining(`agent-task check 'cd '\\''my app'\\'' && mise run check'`),
      }),
    );
  });
});
