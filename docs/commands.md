# Commands

The `agent-task` commands, their flags and output, and the store they read and write. [`SPEC.md`](../SPEC.md) states what must hold.

Each command prints [TOON](https://toonformat.dev): a result on stdout, or an error on stderr naming the act that resolves it, each beside the command's name and `ok`.

| Command | Does |
| --- | --- |
| `agent-task add <name> --repo <path> --goal <text> [--plan <file>] [--priority urgent\|high\|medium\|low] [--after <name>]... [--waits <text>] [--until <command>]` | Queue a task under a kebab-case name: its repository, goal, plan, priority, the tasks it waits after, what else it waits for and the check that says its wait is met; on a queued name, replace them |
| `agent-task start <name> --repo <path> --brief <file> [--session <id>]` | Run a task, new or queued, recording its repository, its brief with the brief's sha, and the session; refused `blocked` while a task it waits after is still held |
| `agent-task wait <name> [--after <name>]... [--waits <text>] [--until <command>]` | Replace what a task waits for: tasks to land and a check that says the wait is met, on a queued task, and anything else as text; with none of the three, clear all three |
| `agent-task review <name>` | Record that a running task was handed back for review; its brief and brief sha stay recorded until `stop` or `done` |
| `agent-task list [--started [--brief-under <dir>]] [--full]` | List the running and in-review tasks, oldest started first, flagging each whose brief changed since it started; then the queued tasks `ready` to start and those `waiting`, each by priority, added time and name, running each one's check, whose result `--full` prints as `untilState`. With `--started`, print `count` and `tasks` alone, reading no queued task and running no check; adding `--brief-under <dir>`, print them only when one's brief sits under that directory, and otherwise refuse `no_brief_under` |
| `agent-task stop <name>` | Take a running or in-review task back to queued, forgetting its brief, session and review time and keeping its goal, plan, priority and waits |
| `agent-task done <name>` | Remove a task in any state, whatever became of its work |
| `agent-task doctor [--full]` | Report what agent-task and its plugin need: the store, `bash`, `agent-task`, `jq` and git on `PATH`, each task's repository, each running or in-review task's brief and each plan a task names, each check `ok`, `warn` or `fail` with its fix; exit 1 when one fails |
| `agent-task --version` | Print the version alone on one line, not as TOON |

## Default views

`list` and `doctor` lead their result with `count`, then print by default the fields an agent acts on, each list a TOON table, and every field with `--full`.

| Command | `count` | Default fields | `--full` adds |
| --- | --- | --- | --- |
| `list` | `running`, `review`, `ready`, `waiting` | `tasks{name,state,brief,briefChanged}`, `ready{name,repo}`, `waiting{name,repo}` | Every field of each task, `reviewed` `null` on a running one, and each queued task's goal, plan, priority, waits, `after`, `until` and `untilState` |
| `list --started` | `running`, `review` | `tasks{name,state,brief,briefChanged}` | Every field of each task |
| `doctor` | `ok`, `warn`, `fail` | `checks{name,state,detail}`, then `fixes{name,fix}` for each check that warns or fails | Each check with its `fix`, `null` when it passes, in place of `fixes` |

## Names and waits

- `add` and `start` refuse a name the store holds running or in review.
- `list` flags a running or in-review task whose brief no longer has the sha it started with, or is gone or unreadable.
- A removed name is free to add or start again.
- A task waits after a name only while the store holds it: `done` frees what waited after the name, and `add` of the name again blocks them again.
- `waits` is text for the listing and stops nothing.
- `until` is a shell command recorded as given. `list` runs it as `/bin/sh -c` in the task's repository, under the time limit [SPEC FR-33](../SPEC.md) sets, and `list --full` prints the result as `untilState`: `met` on exit 0, `unmet` on exit 1 through 125, `timed_out`, or `failed` on exit 126 and up, a signal, or a repository that is gone. A task waiting after no held name is ready when its check is met, whatever its `waits`, or when it has no check and no `waits`. `start` drops the check with the task's `after`, and `stop` returns the task to the queue with neither.
- `doctor` contacts no remote and reads no origin.

## The store

The store lives on this machine, at `$XDG_DATA_HOME/agent-task/tasks.db` (`~/.local/share/agent-task/tasks.db` by default). A store of schema version 1 or 2, written by an earlier agent-task, is migrated by the first command that opens it, keeping every task it holds.
