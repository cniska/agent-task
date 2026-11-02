import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Channel = "homebrew" | "npm" | "bun" | "curl";

const CHANNELS: readonly Channel[] = ["homebrew", "npm", "bun", "curl"];

export type Fetch = (
  url: string,
  init: { readonly signal: AbortSignal; readonly headers: Readonly<Record<string, string>> },
) => Promise<Response>;

export type UpdateCheck = {
  readonly version: string;
  readonly channel: Channel;
  readonly statePath: string;
  readonly now: Date;
  readonly timeoutMs: number;
  readonly fetch: Fetch;
};

type Known = Readonly<Partial<Record<Channel, string>>>;

type State = { readonly checked: Date; readonly latest: Known };

type Source = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly latest: (body: string) => string | null;
};

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

const HOMEBREW_BINARY = /\/Cellar\/agent-task\/[^/]+\/bin\/agent-task$/;

const NPM_BINARY =
  /\/node_modules\/@cniska\/agent-task\/node_modules\/@cniska\/agent-task-[a-z0-9]+-[a-z0-9]+\/agent-task$/;

const BUN_BINARY = /\/install\/global\/node_modules\/@cniska\/agent-task-[a-z0-9]+-[a-z0-9]+\/agent-task$/;

const FORMULA_URL = /url "https:\/\/github\.com\/cniska\/agent-task\/releases\/download\/([^/"]+)\//g;

const CURL_INSTALL =
  "curl -fsSL https://github.com/cniska/agent-task/releases/latest/download/install.sh | sh";

const UPGRADE: Readonly<Record<Channel, string>> = {
  homebrew: "brew upgrade agent-task",
  npm: "npm update -g @cniska/agent-task",
  bun: "bun update -g @cniska/agent-task",
  curl: CURL_INSTALL,
};

const JSON_ACCEPTED = { accept: "application/json" };

const REGISTRY_TAGS: Source = {
  url: "https://registry.npmjs.org/-/package/@cniska/agent-task/dist-tags",
  headers: JSON_ACCEPTED,
  latest: (body) => textAt(parsedJson(body), "latest"),
};

const SOURCES: Readonly<Record<Channel, Source>> = {
  homebrew: {
    url: "https://raw.githubusercontent.com/cniska/homebrew-tap/main/Formula/agent-task.rb",
    headers: {},
    latest: formulaTag,
  },
  npm: REGISTRY_TAGS,
  bun: REGISTRY_TAGS,
  curl: {
    url: "https://api.github.com/repos/cniska/agent-task/releases/latest",
    headers: { accept: "application/vnd.github+json" },
    latest: (body) => textAt(parsedJson(body), "tag_name"),
  },
};

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function installChannel(executable: string, curlInstall: string): Channel | null {
  const binary = realPath(executable);
  if (binary === null) return null;
  if (HOMEBREW_BINARY.test(binary)) return "homebrew";
  if (NPM_BINARY.test(binary)) return "npm";
  if (BUN_BINARY.test(binary)) return "bun";
  if (binary === realPath(curlInstall)) return "curl";
  return null;
}

function parsedJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function textAt(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const found = Reflect.get(value, key);
  return typeof found === "string" ? found : null;
}

function formulaTag(formula: string): string | null {
  const tags = new Set([...formula.matchAll(FORMULA_URL)].map((match) => match[1]));
  const [only] = tags;
  return tags.size === 1 && only !== undefined ? only : null;
}

function versionOf(text: string): readonly [number, number, number] | null {
  const match = VERSION.exec(text);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function normalized(text: string | null): string | null {
  const version = text === null ? null : versionOf(text);
  return version === null ? null : version.join(".");
}

function isNewer(latest: string, running: string): boolean {
  const [ahead, behind] = [versionOf(latest), versionOf(running)];
  if (ahead === null || behind === null) return false;
  const differing = ahead.findIndex((part, index) => part !== behind[index]);
  return differing !== -1 && (ahead[differing] ?? 0) > (behind[differing] ?? 0);
}

function knownOf(value: unknown): Known | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  const valid = entries.every(
    ([channel, version]) =>
      CHANNELS.some((known) => known === channel) &&
      typeof version === "string" &&
      normalized(version) === version,
  );
  return valid ? Object.fromEntries(entries) : null;
}

function readState(path: string): State | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const value = parsedJson(text);
  const checked = textAt(value, "checked");
  const latest = knownOf(typeof value === "object" && value !== null ? Reflect.get(value, "latest") : null);
  if (checked === null || latest === null) return null;
  const time = new Date(checked);
  return Number.isNaN(time.getTime()) ? null : { checked: time, latest };
}

function bestEffort(act: () => void): boolean {
  try {
    act();
    return true;
  } catch {
    return false;
  }
}

function stateWritten(path: string, state: State): boolean {
  const partial = `${path}.${randomUUID()}`;
  const text = `${JSON.stringify({ checked: state.checked.toISOString(), latest: state.latest })}\n`;
  const written =
    bestEffort(() => mkdirSync(dirname(path), { recursive: true })) &&
    bestEffort(() => writeFileSync(partial, text));
  if (!written) return false;
  if (bestEffort(() => renameSync(partial, path))) return true;
  bestEffort(() => rmSync(partial, { force: true }));
  return false;
}

function isDue(state: State | null, now: Date): boolean {
  if (state === null) return true;
  const elapsed = now.getTime() - state.checked.getTime();
  return elapsed < 0 || elapsed >= CHECK_INTERVAL_MS;
}

async function fetchedLatest({ channel, fetch, timeoutMs }: UpdateCheck): Promise<string | null> {
  const source = SOURCES[channel];
  try {
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: source.headers,
    });
    if (!response.ok) return null;
    return normalized(source.latest(await response.text()));
  } catch {
    return null;
  }
}

async function refreshedLatest(check: UpdateCheck, known: Known): Promise<string | null> {
  const recorded = known[check.channel] ?? null;
  if (!stateWritten(check.statePath, { checked: check.now, latest: known })) return recorded;
  const latest = await fetchedLatest(check);
  if (latest === null) return recorded;
  stateWritten(check.statePath, { checked: check.now, latest: { ...known, [check.channel]: latest } });
  return latest;
}

function noticeLine(channel: Channel, latest: string, running: string): string {
  return `agent-task ${latest} is out (running ${running}): run ${UPGRADE[channel]}; if you cannot, tell the user.`;
}

export async function updateNotice(check: UpdateCheck): Promise<string | null> {
  const state = readState(check.statePath);
  const known = state?.latest ?? {};
  const latest = isDue(state, check.now)
    ? await refreshedLatest(check, known)
    : (known[check.channel] ?? null);
  return latest !== null && isNewer(latest, check.version)
    ? noticeLine(check.channel, latest, check.version)
    : null;
}
