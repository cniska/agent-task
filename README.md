# agent-task

Keep track of the coding-agent tasks running in parallel on this machine: each task's name, the repository its work lands in, and its brief, the file of instructions the task was started from, recorded by path with a git blob sha of its content at the start. It refuses a second task under a name already used, and `list` flags a task whose brief no longer has that sha or is gone or unreadable. A task closes as done only once its commits are on origin's default branch, or is dropped when its work is given up. [`SPEC.md`](SPEC.md) states what must hold.

agent-task holds work only while it is being worked on. It is not an issue tracker such as Linear: it keeps no backlog and no priority, lists no task once it is done or dropped, and a task enters it when an agent starts on it. It depends on git alone and keeps its store on this machine, at `$XDG_DATA_HOME/agent-task/tasks.db` (`~/.local/share/agent-task/tasks.db` by default).

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
| `agent-task start <name> --repo <path> --brief <file>` | Record a running task under a kebab-case name the store has never held |
| `agent-task list` | List the running tasks, oldest first, flagging each whose brief changed since it started |
| `agent-task done <name> --commit <sha>...` | Close a running task once every commit is reachable from origin's default branch, after a fetch |
| `agent-task drop <name> --reason <text>` | Close a running task whose work was given up |
| `agent-task --version` | Print the version alone on one line, not as JSON |

`done` and `drop` are final, and a name stays taken after either.

## Claude Code plugin

The `cniska-task` plugin, in `plugin/`, keeps a running task's brief from changing under the task, and reads the store only through the CLI:

- Before each `Edit`, `Write` or `MultiEdit`, it denies an edit to a file that is the brief of a running task. The denial names the task and what to do, in order: `agent-task drop <name> --reason <text>`, then the edit, then `agent-task start <new-name> --repo <repo> --brief <file>` under a name the store has never held. A brief that is gone is still matched by its path. Every other edit passes without a word.
- When a session starts, resumes, clears or compacts in a working directory that holds the brief of a running task, it puts the running tasks in the session's context as `list` prints them, `briefChanged` included. Elsewhere it prints nothing.

A hook prints nothing and denies nothing when `agent-task` is not on `PATH` or `list` is refused, and never exits with an error. Without `jq` or `realpath` it leaves a note on stderr.

## Development

`bun run check` runs lint, typecheck, knip and the tests; `bun run acceptance` runs the acceptance suite. [`AGENTS.md`](AGENTS.md) holds the rules every change follows, and [`src/README.md`](src/README.md) maps the modules.
