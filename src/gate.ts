import { basename } from "node:path";
import { refusals } from "./coded-error";

type Words = readonly string[];

type Lexed = { readonly commands: Words[]; readonly end: number };

const CHECK_NAMES = new Set(["test", "check", "verify", "lint", "typecheck", "build"]);

const WATCH = "watch";

const WATCH_FLAG = "--watch";

const SEPARATORS = new Set([";", "&", "|"]);

const REDIRECTS = new Set(["<", ">"]);

const REDIRECT_TAILS = new Set(["&", ">", "|", "<"]);

const DESCRIPTOR = /^\d+$/;

const DELIMITER_END = /[\s;&|<>()]/;

const QUOTING = /['"\\]/g;

const LEADING_TABS = /^\t+/;

type HereDocument = { readonly delimiter: string; readonly stripsTabs: boolean; readonly expands: boolean };

const BLANKS = new Set([" ", "\t", "\r"]);

const LEADING_WORDS = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "time",
  "command",
  "exec",
  "nohup",
]);

const FLAGGED_WRAPPERS = new Set(["env", "sudo", "xargs"]);

const VALUED_WRAPPERS = new Set(["nice", "timeout"]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const NUMBER = /^\d/;

const SHELL_COMMAND_FLAG = /^-[a-z]*c[a-z]*$/;

const PROGRAM = "agent-task";

const GATED = "check";

export const GATE_USAGE = {
  check: "agent-task check '<command>'",
  gate: "agent-task gate '<command>'",
} as const;

function closingQuote(text: string, from: number): number {
  const end = text.indexOf("'", from);
  return end === -1 ? text.length : end;
}

function closingBacktick(text: string, from: number): number {
  for (let at = from; at < text.length; at += 1) {
    if (text[at] === "\\") at += 1;
    else if (text[at] === "`") return at;
  }
  return text.length;
}

function substitutionsIn(text: string): Words[] {
  const commands: Words[] = [];
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === "\\") at += 1;
    else if (text[at] === "$" && text[at + 1] === "(") {
      const inner = lexFrom(text, at + 2, true);
      commands.push(...inner.commands);
      at = inner.end;
    } else if (text[at] === "`") {
      const end = closingBacktick(text, at + 1);
      commands.push(...lexFrom(text.slice(at + 1, end), 0, false).commands);
      at = end;
    }
  }
  return commands;
}

function lexFrom(text: string, start: number, nested: boolean): Lexed {
  const commands: Words[] = [];
  const hereDocuments: HereDocument[] = [];
  let words: string[] = [];
  let word: string | null = null;
  let redirected = false;
  const endWord = () => {
    if (word !== null && !redirected) words.push(word);
    if (word !== null) redirected = false;
    word = null;
  };
  const endCommand = () => {
    endWord();
    redirected = false;
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const append = (part: string) => {
    word = (word ?? "") + part;
  };
  const substitute = (from: number): number => {
    const inner = lexFrom(text, from, true);
    commands.push(...inner.commands);
    return inner.end;
  };
  const backticks = (from: number): number => {
    const end = closingBacktick(text, from);
    commands.push(...lexFrom(text.slice(from, end), 0, false).commands);
    return end;
  };
  let at = start;
  while (at < text.length) {
    const char = text[at] ?? "";
    const next = text[at + 1] ?? "";
    if (BLANKS.has(char)) endWord();
    else if (char === "#" && word === null) {
      const newline = text.indexOf("\n", at);
      at = newline === -1 ? text.length : newline - 1;
    } else if (char === "(") {
      endCommand();
      const inner = lexFrom(text, at + 1, true);
      commands.push(...inner.commands);
      at = inner.end;
    } else if (char === ")") {
      endCommand();
      if (nested) return { commands, end: at };
    } else if (char === "<" && next === "<" && text[at + 2] !== "<") {
      endWord();
      at = hereDocument(at + 2);
    } else if (REDIRECTS.has(char)) {
      if (word !== null && DESCRIPTOR.test(word)) word = null;
      endWord();
      redirected = true;
      while (REDIRECT_TAILS.has(text[at + 1] ?? "")) at += 1;
    } else if (char === "\n") {
      endCommand();
      at = hereDocumentBodies(at + 1) - 1;
    } else if (SEPARATORS.has(char)) endCommand();
    else if (char === "\\") {
      if (next !== "\n") append(next);
      at += 1;
    } else if (char === "'") {
      const end = closingQuote(text, at + 1);
      append(text.slice(at + 1, end));
      at = end;
    } else if (char === '"') at = doubleQuoted(at + 1);
    else if (char === "$" && next === "(") {
      append("");
      at = substitute(at + 2);
    } else if (char === "`") {
      append("");
      at = backticks(at + 1);
    } else append(char);
    at += 1;
  }
  endCommand();
  return { commands, end: at };

  function hereDocument(from: number): number {
    const stripsTabs = text[from] === "-";
    let cursor = stripsTabs ? from + 1 : from;
    while (BLANKS.has(text[cursor] ?? "")) cursor += 1;
    const begin = cursor;
    while (cursor < text.length && !DELIMITER_END.test(text[cursor] ?? "")) cursor += 1;
    const raw = text.slice(begin, cursor);
    hereDocuments.push({
      delimiter: raw.replace(QUOTING, ""),
      stripsTabs,
      expands: raw === raw.replace(QUOTING, ""),
    });
    return cursor - 1;
  }

  function hereDocumentBodies(from: number): number {
    let cursor = from;
    for (const { delimiter, stripsTabs, expands } of hereDocuments.splice(0)) {
      const begin = cursor;
      let body = text.length;
      while (cursor < text.length) {
        const newline = text.indexOf("\n", cursor);
        const end = newline === -1 ? text.length : newline;
        const line = text.slice(cursor, end);
        const lineStart = cursor;
        cursor = end + 1;
        if ((stripsTabs ? line.replace(LEADING_TABS, "") : line) === delimiter) {
          body = lineStart;
          break;
        }
      }
      if (expands) commands.push(...substitutionsIn(text.slice(begin, body)));
    }
    return Math.min(cursor, text.length);
  }

  function doubleQuoted(from: number): number {
    let literal = "";
    for (let inside = from; inside < text.length; inside += 1) {
      const char = text[inside] ?? "";
      if (char === '"') {
        append(literal);
        return inside;
      }
      if (char === "\\") {
        const escaped = text[inside + 1] ?? "";
        if (escaped !== "\n") literal += escaped;
        inside += 1;
      } else if (char === "$" && text[inside + 1] === "(") inside = substitute(inside + 2);
      else if (char === "`") inside = backticks(inside + 1);
      else literal += char;
    }
    append(literal);
    return text.length;
  }
}

function lexed(text: string): readonly Words[] {
  return lexFrom(text, 0, false).commands;
}

function isFlag(word: string): boolean {
  return word.startsWith("-");
}

function withoutLeading(words: Words, drops: (word: string) => boolean): Words {
  const start = words.findIndex((word) => !drops(word));
  return start === -1 ? [] : words.slice(start);
}

function afterWrapper(words: Words): Words {
  const [first = "", ...rest] = words;
  const program = basename(first);
  if (ASSIGNMENT.test(first) || LEADING_WORDS.has(first)) return rest;
  if (FLAGGED_WRAPPERS.has(program))
    return withoutLeading(rest, (word) => isFlag(word) || ASSIGNMENT.test(word));
  if (VALUED_WRAPPERS.has(program)) return withoutLeading(rest, (word) => isFlag(word) || NUMBER.test(word));
  if (program === "mise" && (rest[0] === "exec" || rest[0] === "x")) {
    const separator = rest.indexOf("--");
    return separator === -1 ? [] : rest.slice(separator + 1);
  }
  return words;
}

function unwrapped(words: Words): Words {
  const inner = afterWrapper(words);
  return inner === words ? words : unwrapped(inner);
}

function isCheckName(word: string): boolean {
  const parts = word.split(":");
  return CHECK_NAMES.has(parts[0] ?? "") && !parts.includes(WATCH);
}

function namesCheck(words: Words): boolean {
  return words.some((word) => !isFlag(word) && isCheckName(word));
}

function runsScript([sub, ...rest]: Words): boolean {
  return (sub === "run" || sub === "run-script") && namesCheck(rest);
}

const isTest = ([sub]: Words) => sub === "test";

const always = () => true;

const RUNNERS: Readonly<Record<string, (args: Words) => boolean>> = {
  mise: ([sub, ...rest]) => (sub === "run" || sub === "r") && namesCheck(rest),
  bun: (args) => isTest(args) || runsScript(args),
  npm: (args) => isTest(args) || runsScript(args),
  pnpm: namesCheck,
  yarn: namesCheck,
  flutter: isTest,
  dart: isTest,
  cargo: isTest,
  busted: always,
  xcodebuild: always,
};

function isCheck(program: string, args: Words): boolean {
  return Object.hasOwn(RUNNERS, program) && RUNNERS[program]?.(args) === true;
}

function checksIn(words: Words): readonly string[] {
  const command = unwrapped(words);
  const [first, ...args] = command;
  if (first === undefined) return [];
  const program = basename(first);
  if (program === PROGRAM && args[0] === GATED) return [];
  if (SHELLS.has(program)) {
    const flag = args.findIndex((word) => SHELL_COMMAND_FLAG.test(word));
    const script = flag === -1 ? undefined : args[flag + 1];
    return script === undefined ? [] : ungatedChecks(script);
  }
  if (args.includes(WATCH_FLAG) || !isCheck(program, args)) return [];
  return [command.join(" ")];
}

export function ungatedChecks(command: string): readonly string[] {
  return lexed(command).flatMap(checksIn);
}

function quoted(command: string): string {
  return `'${command.replaceAll("'", "'\\''")}'`;
}

const refuse = refusals<{
  readonly check_ungated: { readonly command: string; readonly checks: readonly string[] };
}>({
  check_ungated: {
    message: ({ checks }) =>
      `this command runs ${checks.join(", ")} outside agent-task check, which runs one check at a time across this machine and only while it is under its limits`,
    resolve: ({ command }) =>
      `run the command as agent-task check ${quoted(command)}, in the background when it may wait longer than the tool's time limit`,
  },
});

export function refuseUngated(command: string): { readonly gated: true } {
  const checks = ungatedChecks(command);
  if (checks.length > 0) throw refuse("check_ungated", { command, checks });
  return { gated: true };
}
