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

## Development

`bun run check` runs lint, typecheck, knip and the tests; `bun run acceptance` runs the acceptance suite. [`AGENTS.md`](AGENTS.md) holds the rules every change follows, and [`src/README.md`](src/README.md) maps the modules.
