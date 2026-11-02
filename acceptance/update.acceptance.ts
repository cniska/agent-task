import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  binWith,
  compiledBinary,
  packageVersion,
  type Ran,
  removeScratchDirs,
  runProgram,
  type World,
  world,
} from "./harness";

afterEach(removeScratchDirs);

const BUILD_TIMEOUT_MS = 60_000;

const TARGET = `${process.platform}-${process.arch}`;

const NEWER = "99.0.0";

const OFF_SWITCH = "AGENT_TASK_NO_UPDATE_CHECK";

const LEFT_ON: readonly Readonly<Record<string, string>>[] = [{ CI: "" }, { [OFF_SWITCH]: " " }];

const TURNED_OFF: readonly Readonly<Record<string, string>>[] = [{ CI: "true" }, { [OFF_SWITCH]: "1" }];

const UPGRADES = {
  homebrew: "brew upgrade agent-task",
  npm: "npm update -g @cniska/agent-task",
  bun: "bun update -g @cniska/agent-task",
  curl: "curl -fsSL https://github.com/cniska/agent-task/releases/latest/download/install.sh | sh",
} as const;

type Channel = keyof typeof UPGRADES;

const CHANNELS: readonly Channel[] = ["homebrew", "npm", "bun", "curl"];

function home(w: World): string {
  return w.env.HOME ?? "";
}

function stateHome(w: World): string {
  return w.env.XDG_STATE_HOME ?? "";
}

function copied(binary: string, to: string): string {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(binary, to);
  chmodSync(to, 0o755);
  return to;
}

function installs(w: World, binary: string): Readonly<Record<Channel, string>> {
  const cellar = copied(
    binary,
    join(w.root, "brew", "Cellar", "agent-task", packageVersion(), "bin", "agent-task"),
  );
  const brewLink = join(w.root, "brew", "bin", "agent-task");
  mkdirSync(dirname(brewLink), { recursive: true });
  symlinkSync(cellar, brewLink);
  const platformPackage = join("node_modules", "@cniska", `agent-task-${TARGET}`, "agent-task");
  return {
    homebrew: brewLink,
    npm: copied(binary, join(w.root, "npm", "lib", "node_modules", "@cniska", "agent-task", platformPackage)),
    bun: copied(binary, join(home(w), ".bun", "install", "global", platformPackage)),
    curl: copied(binary, join(home(w), ".local", "bin", "agent-task")),
  };
}

function seeded(dir: string, latest: string): string {
  const path = join(dir, "agent-task", "update-check.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      checked: new Date().toISOString(),
      latest: Object.fromEntries(CHANNELS.map((c) => [c, latest])),
    }),
  );
  return path;
}

function line(channel: Channel): string {
  return `agent-task ${NEWER} is out (running ${packageVersion()}): run ${UPGRADES[channel]}; if you cannot, tell the user.\n`;
}

function running(
  w: World,
  binary: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Ran {
  return runProgram(w, w.root, binary, args, { env, unset: OFF_SWITCH in env ? [] : [OFF_SWITCH] });
}

function quietly(w: World, binary: string, args: readonly string[]): Ran {
  return runProgram(w, w.root, binary, args);
}

test(
  "AC-47 the release binary installed through Homebrew, npm, Bun and the curl installer prints one line on stderr naming its channel's upgrade while a newer version is known, its stdout and exit as they were, and nothing at that version, off its channels, or with CI or the off switch set",
  () => {
    const w = world();
    const binary = compiledBinary(w, join(w.root, "build"));
    const path = binWith(w, ["git"], false, "git-bin");
    const atPath = { PATH: path };
    const placed = installs(w, binary);
    const state = seeded(stateHome(w), NEWER);
    const before = readFileSync(state, "utf8");

    for (const channel of CHANNELS)
      for (const args of [["--version"], ["list"], ["no-such-command"]]) {
        const quiet = quietly(w, placed[channel], args);
        expect(running(w, placed[channel], args, atPath)).toEqual({
          exitCode: quiet.exitCode,
          stdout: quiet.stdout,
          stderr: `${line(channel)}${quiet.stderr}`,
        });
      }
    expect(readFileSync(state, "utf8")).toBe(before);

    for (const env of TURNED_OFF)
      expect(running(w, placed.curl, ["--version"], { ...atPath, ...env })).toEqual({
        exitCode: 0,
        stdout: `${packageVersion()}\n`,
        stderr: "",
      });
    for (const env of LEFT_ON)
      expect(running(w, placed.curl, ["--version"], { ...atPath, ...env }).stderr).toBe(line("curl"));

    seeded(stateHome(w), packageVersion());
    expect(running(w, placed.homebrew, ["--version"], atPath).stderr).toBe("");

    const fresh = world();
    const elsewhere = copied(binary, join(fresh.root, "elsewhere", "agent-task"));
    const freshCurl = copied(binary, join(home(fresh), ".local", "bin", "agent-task"));
    expect(running(fresh, elsewhere, ["--version"]).stderr).toBe("");
    expect(running(fresh, freshCurl, ["--version"], { CI: "1" }).stderr).toBe("");
    expect(existsSync(join(stateHome(fresh), "agent-task"))).toBe(false);

    seeded(join(home(fresh), ".local", "state"), NEWER);
    const unsetStateHome = runProgram(fresh, fresh.root, freshCurl, ["--version"], {
      unset: [OFF_SWITCH, "XDG_STATE_HOME"],
    });
    expect(unsetStateHome.stderr).toBe(line("curl"));
  },
  BUILD_TIMEOUT_MS,
);
