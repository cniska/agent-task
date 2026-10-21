# Commands

The `agent-task` commands, their flags and output, and the store they read and write. [`SPEC.md`](../SPEC.md) states what must hold.

Each command prints one JSON line: a result on stdout, or an error on stderr naming the act that resolves it.

| Command | Does |
| --- | --- |
| `agent-task add <name> --repo <path> --goal <text> [--plan <file>] [--priority urgent\|high\|medium\|low] [--after <name>]... [--waits <text>]` | Queue a task under a kebab-case name: its repository, goal, plan, priority, the tasks it waits after and what else it waits for; on a queued name, replace them |
| `agent-task start <name> --repo <path> --brief <file> [--session <id>]` | Run a task, new or queued, recording its repository, its brief with the brief's sha, and the session; refused `blocked` while a task it waits after is still held |
| `agent-task wait <name> [--after <name>]... [--waits <text>]` | Replace what a task waits for: tasks to land, on a queued task, and anything else as text; with neither, clear both |
| `agent-task review <name>` | Record that a running task was handed back for review; its brief stays frozen until `stop` or `done` |
| `agent-task list` | List the running and in-review tasks, oldest started first, flagging each whose brief changed since it started; then the queued tasks `ready` to start and those `waiting`, each by priority, added time and name |
| `agent-task stop <name>` | Take a running or in-review task back to queued, forgetting its brief, session and review time and keeping its goal, plan, priority and waits |
| `agent-task done <name>` | Remove a task in any state, whatever became of its work |
| `agent-task doctor` | Report what agent-task and its plugin need: the store, `bash`, `agent-task`, `jq`, `realpath` and git on `PATH`, each task's repository, each running or in-review task's brief and each plan a task names, each check `ok`, `warn` or `fail` with its fix; exit 1 when one fails |
| `agent-task --version` | Print the version alone on one line, not as JSON |

## Names and waits

- `add` and `start` refuse a name the store holds running or in review.
- `list` flags a running or in-review task whose brief no longer has the sha it started with, or is gone or unreadable.
- A removed name is free to add or start again.
- A task waits after a name only while the store holds it: `done` frees what waited after the name, and `add` of the name again blocks them again.
- `waits` is text for the listing and stops nothing.
- `doctor` contacts no remote and reads no origin.

## The store

The store lives on this machine, at `$XDG_DATA_HOME/agent-task/tasks.db` (`~/.local/share/agent-task/tasks.db` by default). A store written by the agent-task before this one is migrated by the first command that opens it, keeping every running task.
