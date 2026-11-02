import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { removeScratchDirs, scratchDir } from "./repo.test-support";
import { type Channel, type Fetch, installChannel, type UpdateCheck, updateNotice } from "./update";

afterAll(removeScratchDirs);

const NOW = new Date("2026-11-02T12:00:00.000Z");

const HOUR_MS = 60 * 60 * 1000;

const FORMULA_URL = "https://raw.githubusercontent.com/cniska/homebrew-tap/main/Formula/agent-task.rb";

const REGISTRY_URL = "https://registry.npmjs.org/-/package/@cniska/agent-task/dist-tags";

const RELEASE_URL = "https://api.github.com/repos/cniska/agent-task/releases/latest";

const CURL_LINE = "curl -fsSL https://github.com/cniska/agent-task/releases/latest/download/install.sh | sh";

function formula(...tags: readonly string[]): string {
  return [
    "class AgentTask < Formula",
    ...tags.map(
      (tag) =>
        `  url "https://github.com/cniska/agent-task/releases/download/${tag}/agent-task-darwin-arm64.tar.gz"`,
    ),
    "end",
  ].join("\n");
}

type Served = { readonly status: number; readonly body: string };

function serving(answers: Readonly<Record<string, Served>>): { fetch: Fetch; asked: string[] } {
  const asked: string[] = [];
  const fetch: Fetch = async (url) => {
    asked.push(url);
    const answer = answers[url] ?? { status: 404, body: "" };
    return new Response(answer.body, { status: answer.status });
  };
  return { fetch, asked };
}

const LATEST_EVERYWHERE: Readonly<Record<string, Served>> = {
  [FORMULA_URL]: { status: 200, body: formula("v0.4.0", "v0.4.0") },
  [REGISTRY_URL]: { status: 200, body: JSON.stringify({ latest: "0.4.0", next: "0.5.0-rc.1" }) },
  [RELEASE_URL]: { status: 200, body: JSON.stringify({ tag_name: "v0.4.0" }) },
};

const throwing: Fetch = async () => {
  throw new TypeError("network down");
};

const hanging: Fetch = (_url, { signal }) =>
  new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

function check(overrides: Partial<UpdateCheck> & Pick<UpdateCheck, "fetch">): UpdateCheck {
  return {
    version: "0.3.0",
    channel: "homebrew",
    statePath: join(scratchDir(), "state", "agent-task", "update-check.json"),
    now: NOW,
    timeoutMs: 1000,
    ...overrides,
  };
}

function seeded(path: string, checked: Date, latest: Readonly<Record<string, string>>): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ checked: checked.toISOString(), latest }));
  return path;
}

function stateAt(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function placed(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  return path;
}

describe("the install channel", () => {
  const root = scratchDir();
  const curl = join(root, "home", ".local", "bin", "agent-task");

  test("is homebrew for a binary in the formula's Cellar, reached through its link", () => {
    const cellar = placed(join(root, "brew", "Cellar", "agent-task", "0.3.0", "bin", "agent-task"));
    const link = join(root, "brew", "bin", "agent-task");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(cellar, link);
    expect(installChannel(cellar, curl)).toBe("homebrew");
    expect(installChannel(link, curl)).toBe("homebrew");
  });

  test("is npm for the platform build nested under the global package", () => {
    const binary = placed(
      join(
        root,
        "npm",
        "lib",
        "node_modules",
        "@cniska",
        "agent-task",
        "node_modules",
        "@cniska",
        "agent-task-darwin-arm64",
        "agent-task",
      ),
    );
    expect(installChannel(binary, curl)).toBe("npm");
  });

  test("is bun for the platform build in Bun's global install", () => {
    const binary = placed(
      join(
        root,
        ".bun",
        "install",
        "global",
        "node_modules",
        "@cniska",
        "agent-task-linux-x64",
        "agent-task",
      ),
    );
    expect(installChannel(binary, curl)).toBe("bun");
  });

  test("is curl for the installer's binary in ~/.local/bin", () => {
    expect(installChannel(placed(curl), curl)).toBe("curl");
  });

  test("is unknown for a build anywhere else, a project's own node_modules, or a path that is gone", () => {
    const local = placed(
      join(root, "project", "node_modules", "@cniska", "agent-task-darwin-arm64", "agent-task"),
    );
    expect(installChannel(placed(join(root, "checkout", "agent-task")), curl)).toBeNull();
    expect(installChannel(local, curl)).toBeNull();
    expect(installChannel(join(root, "gone", "agent-task"), join(root, "gone", "agent-task"))).toBeNull();
  });
});

describe("the update notice", () => {
  const upgrades: readonly (readonly [Channel, string, string])[] = [
    ["homebrew", FORMULA_URL, "brew upgrade agent-task"],
    ["npm", REGISTRY_URL, "npm update -g @cniska/agent-task"],
    ["bun", REGISTRY_URL, "bun update -g @cniska/agent-task"],
    ["curl", RELEASE_URL, CURL_LINE],
  ];

  for (const [channel, url, upgrade] of upgrades)
    test(`asks ${channel}'s source once and names its upgrade when it serves a newer version`, async () => {
      const { fetch, asked } = serving(LATEST_EVERYWHERE);
      const given = check({ fetch, channel });
      expect(await updateNotice(given)).toBe(
        `agent-task 0.4.0 is out (running 0.3.0): run ${upgrade}; if you cannot, tell the user.`,
      );
      expect(asked).toEqual([url]);
      expect(stateAt(given.statePath)).toEqual({
        checked: NOW.toISOString(),
        latest: { [channel]: "0.4.0" },
      });
    });

  test("prints nothing when the channel serves the running version or an older one", async () => {
    for (const version of ["0.4.0", "0.10.0", "1.0.0"]) {
      const { fetch } = serving(LATEST_EVERYWHERE);
      expect(await updateNotice(check({ fetch, version }))).toBeNull();
    }
  });

  test("compares versions by number, not by text", async () => {
    const { fetch } = serving({
      [REGISTRY_URL]: { status: 200, body: JSON.stringify({ latest: "0.10.0" }) },
    });
    expect(await updateNotice(check({ fetch, channel: "npm", version: "0.9.0" }))).toContain("0.10.0 is out");
  });

  test("asks nothing within a day of the last check, and prints the line from what it knows", async () => {
    const { fetch, asked } = serving(LATEST_EVERYWHERE);
    const statePath = seeded(
      join(scratchDir(), "update-check.json"),
      new Date(NOW.getTime() - 23 * HOUR_MS),
      {
        homebrew: "0.5.0",
      },
    );
    expect(await updateNotice(check({ fetch, statePath }))).toContain(
      "agent-task 0.5.0 is out (running 0.3.0)",
    );
    expect(await updateNotice(check({ fetch, statePath, channel: "curl" }))).toBeNull();
    expect(asked).toEqual([]);
  });

  test("asks again over a check stamped later than now, recording now", async () => {
    const { fetch, asked } = serving(LATEST_EVERYWHERE);
    const statePath = seeded(join(scratchDir(), "update-check.json"), new Date(NOW.getTime() + HOUR_MS), {});
    expect(await updateNotice(check({ fetch, statePath }))).toContain("0.4.0 is out");
    expect(asked).toEqual([FORMULA_URL]);
    expect(stateAt(statePath)).toEqual({ checked: NOW.toISOString(), latest: { homebrew: "0.4.0" } });
  });

  test("asks again a day after the last check, keeping what it knows of other channels", async () => {
    const { fetch, asked } = serving(LATEST_EVERYWHERE);
    const statePath = seeded(
      join(scratchDir(), "update-check.json"),
      new Date(NOW.getTime() - 24 * HOUR_MS),
      {
        npm: "0.3.5",
      },
    );
    expect(await updateNotice(check({ fetch, statePath }))).toContain("0.4.0 is out");
    expect(asked).toEqual([FORMULA_URL]);
    expect(stateAt(statePath)).toEqual({
      checked: NOW.toISOString(),
      latest: { npm: "0.3.5", homebrew: "0.4.0" },
    });
  });

  test("counts a failed, refused, unparsable or split answer as the day's check and prints nothing", async () => {
    const answers: readonly Served[] = [
      { status: 500, body: "" },
      { status: 200, body: "not a formula" },
      { status: 200, body: formula("v0.4.0", "v0.3.9") },
      { status: 200, body: formula("latest") },
    ];
    for (const answer of answers) {
      const { fetch, asked } = serving({ [FORMULA_URL]: answer });
      const given = check({ fetch });
      expect(await updateNotice(given)).toBeNull();
      expect(stateAt(given.statePath)).toEqual({ checked: NOW.toISOString(), latest: {} });
      expect(await updateNotice({ ...given, now: new Date(NOW.getTime() + HOUR_MS) })).toBeNull();
      expect(asked).toEqual([FORMULA_URL]);
    }
  });

  test("counts a request that throws or outlives the timeout as the day's check and prints nothing", async () => {
    for (const fetch of [throwing, hanging]) {
      const given = check({ fetch, timeoutMs: 5 });
      expect(await updateNotice(given)).toBeNull();
      expect(stateAt(given.statePath)).toEqual({ checked: NOW.toISOString(), latest: {} });
    }
  });

  test("records the day's check before it asks, keeping what it knew, so a run that dies mid-request still counts", async () => {
    const statePath = seeded(
      join(scratchDir(), "update-check.json"),
      new Date(NOW.getTime() - 48 * HOUR_MS),
      {
        npm: "0.3.5",
      },
    );
    const seen: unknown[] = [];
    const recording: Fetch = async () => {
      seen.push(stateAt(statePath));
      throw new TypeError("network down");
    };
    await updateNotice(check({ fetch: recording, statePath }));
    expect(seen).toEqual([{ checked: NOW.toISOString(), latest: { npm: "0.3.5" } }]);
  });

  test("still prints what it knew when the day's check fails", async () => {
    const { fetch } = serving({});
    const statePath = seeded(
      join(scratchDir(), "update-check.json"),
      new Date(NOW.getTime() - 48 * HOUR_MS),
      {
        homebrew: "0.3.2",
      },
    );
    expect(await updateNotice(check({ fetch, statePath }))).toContain("0.3.2 is out");
  });

  test("checks again over a state file it cannot read", async () => {
    for (const text of [
      "not json",
      "{}",
      '{"checked":"never","latest":{}}',
      '{"checked":"2026-11-02T11:00:00Z","latest":{"pip":"1.0.0"}}',
    ]) {
      const statePath = join(scratchDir(), "update-check.json");
      writeFileSync(statePath, text);
      const { fetch, asked } = serving(LATEST_EVERYWHERE);
      expect(await updateNotice(check({ fetch, statePath }))).toContain("0.4.0 is out");
      expect(asked).toEqual([FORMULA_URL]);
    }
  });

  test("asks nothing where it cannot rewrite a due state, and prints the line from what it knew", async () => {
    const dir = join(scratchDir(), "read-only");
    const statePath = seeded(join(dir, "update-check.json"), new Date(NOW.getTime() - 48 * HOUR_MS), {
      homebrew: "0.5.0",
    });
    chmodSync(dir, 0o500);
    const { fetch, asked } = serving(LATEST_EVERYWHERE);
    expect(await updateNotice(check({ fetch, statePath }))).toContain("agent-task 0.5.0 is out");
    expect(asked).toEqual([]);
    chmodSync(dir, 0o700);
  });

  test("asks nothing and throws nothing where it cannot record the day's check", async () => {
    const blocked = placed(join(scratchDir(), "a-file"));
    const statePath = join(blocked, "agent-task", "update-check.json");
    const { fetch, asked } = serving(LATEST_EVERYWHERE);
    for (let run = 0; run < 2; run += 1) expect(await updateNotice(check({ fetch, statePath }))).toBeNull();
    expect(asked).toEqual([]);
    expect(existsSync(statePath)).toBe(false);
  });
});
