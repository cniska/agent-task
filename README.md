# agent-task

Record the tasks a coordinator of coding agents has running: which repository each lands in, its brief, and the brief's content when the work started. It refuses a second task under a name already used, flags a task whose brief changed under its worker, and closes a task only once its commits are on origin's default branch. [`SPEC.md`](SPEC.md) states what must hold.

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
| `agent-task drop <name> --reason <text>` | Close a running task whose work was given up or whose worker died |
| `agent-task --version` | Print the version |

`done` and `drop` are final, and a name stays taken after either.

## Development

`bun run check` runs lint, typecheck, knip and the tests; `bun run acceptance` runs the acceptance suite. [`AGENTS.md`](AGENTS.md) holds the rules every change follows, and [`src/README.md`](src/README.md) maps the modules.
