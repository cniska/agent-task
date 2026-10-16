# agent-task

> Task tracking for coding agents: the tasks running in parallel and the ones waiting to run, each with its repo and the brief it started from

[![CI](https://img.shields.io/github/actions/workflow/status/cniska/agent-task/check.yml?branch=main&style=flat&label=ci)](https://github.com/cniska/agent-task/actions/workflows/check.yml) [![License](https://img.shields.io/badge/license-MIT-blue?style=flat)](LICENSE)

For each task on this machine it records the task's name, the repository its work lands in, and, while the task runs, its brief, a file of instructions, by path with a git blob sha of its content at the start, and the session that started it. It refuses a second task under a name it holds running, and `list` flags a task whose brief no longer has that sha or is gone or unreadable. `stop` takes a running task back to queued, and `done` removes a task when its work is over, however it ended; whether the work landed is git's to show. [`SPEC.md`](SPEC.md) states what must hold.

agent-task is the record of the work on this machine, not an issue tracker such as Linear: it keeps no record of a task once it is removed. It depends on git alone and keeps its store on this machine, at `$XDG_DATA_HOME/agent-task/tasks.db` (`~/.local/share/agent-task/tasks.db` by default). A store written by the agent-task before this one is migrated by the first command that opens it, keeping every running task.

## Install

agent-task runs on [Bun](https://bun.sh), which [mise](https://mise.jdx.dev) installs for it. With mise installed:

```bash
git clone https://github.com/cniska/agent-task.git
cd agent-task
mise trust && mise install
```

`mise install` installs Bun and the dependencies. In the clone it also links `agent-task` into `~/.bun/bin` with `bun link`; in a worktree it does not, so removing a worktree never leaves the command pointing at a deleted checkout. Add that directory to your `PATH` if it is not there yet.

Then, for Claude Code, install the plugin from the `cniska` marketplace:

```bash
claude plugin install cniska-task@cniska
```

The plugin brings neither Bun nor the CLI, and does nothing until `agent-task` is on `PATH`. Its hooks also need `jq` and `realpath`.

## Commands

Each command prints one JSON line: a result on stdout, or an error on stderr naming the act that resolves it.

| Command | Does |
| --- | --- |
| `agent-task start <name> --repo <path> --brief <file> [--session <id>]` | Run a task under a kebab-case name, new or queued, recording its repository, its brief with the brief's sha, and the session |
| `agent-task list` | List the running tasks, oldest first, flagging each whose brief changed since it started, and the queued tasks as `ready` |
| `agent-task stop <name>` | Take a running task back to queued, forgetting its brief and session |
| `agent-task done <name>` | Remove a task, running or queued, whatever became of its work |
| `agent-task doctor` | Report what agent-task and its plugin need: the store, `bash`, `agent-task`, `jq`, `realpath` and git on `PATH`, each task's repository and each running task's brief, each check `ok`, `warn` or `fail` with its fix; exit 1 when one fails |
| `agent-task --version` | Print the version alone on one line, not as JSON |

A removed name is free to start again. `doctor` contacts no remote and reads no origin.

## Claude Code plugin

The `cniska-task` plugin, in `plugin/`, keeps a running task's brief from changing under the task, and reads the store only through the CLI:

- Before each `Edit`, `Write` or `MultiEdit`, it denies an edit to a file that is the brief of a running task. The denial names the task and what to do, in order: `agent-task stop <name>`, then the edit, then `agent-task start <name> --repo <repo> --brief <file> [--session <id>]`, which freezes the edited brief. A brief that is gone is still matched by its path. Every other edit passes without a word.
- When a session starts, resumes, clears or compacts in a working directory that holds the brief of a running task, it puts the running tasks in the session's context as `list` prints them, `briefChanged` included. Elsewhere it prints nothing.

A hook prints nothing and denies nothing when `agent-task` is not on `PATH` or `list` is refused, and never exits with an error. Without `jq` or `realpath` it leaves a note on stderr. When a hook is silent, run `agent-task doctor`. The hooks see the `PATH` Claude Code started with, which can differ from a shell's, for example when the desktop app is opened from the Dock, so run `doctor` under that `PATH`.

## Development

- `bun run check` runs lint, typecheck, knip and the tests.
- `bun run acceptance` runs the acceptance suite. Each acceptance test gets 20 seconds rather than Bun's default 5, since one drives git and the CLI many times and under heavy load took longer than 5; the release criteria, which compile the binary, set their own 60.
- `npm/agent-task` is the npm package's launcher, a POSIX shell script `scripts/build-npm.ts` fills with the release builds; `scripts/launcher.test.ts`, in the check, runs it over the layouts `npm` and `bun` install, with no runtime on `PATH`.
- `scripts/build-compiled.sh <outfile>` compiles the CLI into one executable that needs no Bun, the binary a release ships.
- `scripts/smoke.sh <executable> <version>` is the release's smoke test: the executable prints the version, runs `start`, `list` and `done` on a made-up brief in a scratch repository and passes `doctor` there; the release runs it on each build and on each registry install.
- `scripts/release.sh patch|minor|major` bumps the version and tags it; `.github/workflows/release.yml` builds the tag into a GitHub release, the npm packages and a Homebrew repin, as [Releasing](docs/releasing.md) says.

[`AGENTS.md`](AGENTS.md) holds the rules every change follows, and [`src/README.md`](src/README.md) maps the modules.
