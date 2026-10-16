# agent-task Specification

> The running tasks a coordinator of coding agents holds, recorded so they can be listed, checked and closed.

This document states what must hold, not how. [`README.md`](README.md) has the install and the commands, and [`src/README.md`](src/README.md) maps the modules that meet these requirements.

## 1. Purpose & context

agent-task is a command line program for a coordinator that runs coding agents. It prints its results as JSON for the agents that call it.

## 2. Functional requirements

### 2.1 Output and the version

- **FR-1** — `--version` prints the version alone on one line and exits 0; `--version` with an argument is a usage error.
- **FR-2** — No command, or `--help`, prints one JSON line `{"command":"agent-task","ok":true,"result":{"commands":[...],"flags":[...]}}` listing each command's and flag's name, usage and summary, and exits 0.
- **FR-3** — A result is one JSON line on stdout, `{"command":<name>,"ok":true,"result":<value>}`, with exit 0. An error is one JSON line on stderr, `{"command":<name>,"ok":false,"error":{"kind","code","message","meta","resolve"}}`, where `resolve` names the act that resolves it; the exit is 1 for a refusal, 2 for a usage error and 3 for a fault. An unknown command is the usage error `unknown_command`.

## 3. Non-functional requirements

- **NF-1** — The tests never read or write the real home: `HOME` and the XDG directories point at scratch directories.

## 4. Out of scope

- A release build, an installer and packages.

## 5. Acceptance criteria

- **AC-1** — `--version`, then `--version now`: the version alone on stdout with exit 0 and nothing on stderr, then exit 2 with `wrong_arity` and the usage as the act. (FR-1, FR-3)
- **AC-2** — No command and `--help`: the same one JSON line listing the commands and the `--version` flag, exit 0. (FR-2)
- **AC-3** — An unknown command: exit 2, nothing on stdout, `unknown_command` on stderr naming it. (FR-3)
- **AC-4** — The test environment's `HOME` and XDG directories are scratch directories, not the account's. (NF-1)

## 6. Deliverables

- **D-1** — The `agent-task` CLI, run by Bun from a checkout through `bin/agent-task` and linked onto `PATH` by `mise install` in the primary checkout.
- **D-2** — `README.md`, `AGENTS.md`, `src/README.md` and this spec.
- **D-3** — The test suite, run by `bun run check`, and the acceptance suite, run by `bun run acceptance`, whose test names cite the criteria in §5.

## 7. Constraints (fixed)

- **C-1** — TypeScript on Bun, which mise installs.
