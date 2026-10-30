# agent-task

> Task tracking for coding agents: the tasks running in parallel, the ones handed back for review and the ones waiting to run, each with its repo and the brief it started from

[![CI](https://img.shields.io/github/actions/workflow/status/cniska/agent-task/check.yml?branch=main&style=flat&label=ci)](https://github.com/cniska/agent-task/actions/workflows/check.yml) [![License](https://img.shields.io/badge/license-MIT-blue?style=flat)](LICENSE)

agent-task records each coding-agent task on this machine, with the repository its work lands in, from the time it is queued or started until its work is over.

- `agent-task add <name>` queues a task with its goal, plan, priority, what it waits for and the check that says its wait is met, and `list` prints the queue in the order to start it.
- `agent-task start <name>` runs a task from a brief, recording the brief's path and git blob sha and the session that started it; `review` marks it handed back for review, and `list` flags a brief that changed since.
- `agent-task done <name>` removes a task however its work ended; whether the work landed is git's to show.
- The `cniska-task` Claude Code plugin tells every session that queued and running work lives in agent-task, and puts the running and in-review tasks in its context, each with whether its brief changed.

## Install

Install the `agent-task` command for macOS on Apple silicon or Linux on x64 through one of these channels.

With the release's installer:

```bash
curl -fsSL https://github.com/cniska/agent-task/releases/latest/download/install.sh | sh
```

With Homebrew:

```bash
brew install cniska/tap/agent-task
```

With npm:

```bash
npm install -g @cniska/agent-task
```

With Bun:

```bash
bun add -g @cniska/agent-task
```

The curl line installs `~/.local/bin/agent-task` and, when that directory is not on your `PATH`, adds it to `~/.zshrc` for zsh or to an existing `~/.bashrc` or `~/.bash_profile` for bash, and otherwise asks you to add it. Each channel updates the way it installed: `brew upgrade agent-task`, `npm update -g @cniska/agent-task`, `bun update -g @cniska/agent-task`, or the curl line run again.

Then install the Claude Code plugin:

```bash
claude plugin install cniska-task@cniska
```

## Why

Agents running in parallel on one machine need one record of which task each is on, which work came back for review and what waits to start next. A brief edited while its task runs leaves the agent working from instructions no one can see anymore, so agent-task records the brief's sha when the task starts and `list` flags `briefChanged` once the brief no longer has it.

agent-task is the record of the work on this machine, not an issue tracker such as Linear: it keeps nothing of a task once it is removed, and it depends on git and `/bin/sh` alone.

## Commands

| Command | Does |
| --- | --- |
| `agent-task add <name> --repo <path> --goal <text> [...]` | Queue a task, or replace a queued one |
| `agent-task start <name> --repo <path> --brief <file> [--session <id>]` | Run a task, new or queued, from its brief |
| `agent-task wait <name> [--after <name>]... [--waits <text>] [--until <command>]` | Replace what a task waits for |
| `agent-task review <name>` | Record that a running task was handed back for review |
| `agent-task list [--started [--brief-under <dir>]] [--full]` | List the running and in-review tasks, then the queue, running each queued task's check; `--started` lists the started tasks alone, `--full` every field |
| `agent-task stop <name>` | Take a running or in-review task back to queued |
| `agent-task done <name>` | Remove a task in any state |
| `agent-task doctor [--full]` | Check what agent-task and its plugin need |
| `agent-task` | Run `list` |
| `agent-task --help` | List the commands and flags |
| `agent-task --version` | Print the version |

[Commands](docs/commands.md) lists every command, its flags, its output and the store.

## Docs

- [Commands](docs/commands.md): every command, its flags and output, and where the store lives.
- [Claude Code plugin](docs/plugin.md): what the plugin's hook does and what it needs.
- [Development](docs/development.md): setup, checks, scripts and rules, for working on this repo.
- [Contributing](CONTRIBUTING.md): how outside contributors propose a change.
- [Releasing](docs/releasing.md): the release workflow, what a release guarantees, the owner's one-time setup and each release's steps.

## Related

agent-task works on its own in any agent workflow, and is one of the optional add-ons to [agent-skills](https://github.com/cniska/agent-skills), engineering skills for coding agents. The other add-ons:

- [agent-record](https://github.com/cniska/agent-record): a session record for coding agents, every past session queryable and joined to its commits
- [agent-gates](https://github.com/cniska/agent-gates): commit gates for coding agents, git hooks and CI checks that refuse a bad commit
- [agent-worktree](https://github.com/cniska/agent-worktree): task worktrees for coding agents, one checkout per task, set up and torn down by the project's own commands
