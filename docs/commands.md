# Commands

The `agent-task` commands, their flags and output, and the store they read and write. [`SPEC.md`](../SPEC.md) states what must hold.

Each command prints [TOON](https://toonformat.dev): a result on stdout, or an error on stderr naming the act that resolves it, each beside the command's name and `ok`.

| Command | Does |
| --- | --- |
| `agent-task add <name> --repo <path> --goal <text> [--project <id>] [--plan <file>] [--priority urgent\|high\|medium\|low] [--after <name>]... [--waits <text>] [--until <command>]` | Queue a task under a kebab-case name: its repository, goal, project, plan, priority, the tasks it waits after, what else it waits for and the check that says its wait is met; on a queued name, replace them |
| `agent-task start <name> --repo <path> --brief <file> [--project <id>] [--session <id>]` | Run a task, new or queued, recording its repository, its brief with the brief's sha, the session and, when given, its project; refused `blocked` while a task it waits after is still held |
| `agent-task wait <name> [--after <name>]... [--waits <text>] [--until <command>]` | Replace what a task waits for: tasks to land and a check that says the wait is met, on a queued task, and anything else as text; with none of the three, clear all three |
| `agent-task map <name> --project <id>` | Make a task in any state, or an owner item, belong to a project the store holds |
| `agent-task ask <name> <text> [--project <id>] [--priority urgent\|high\|medium\|low]` | Queue an owner item: a question or a step only the owner can do, in full, with its project and priority; on an owner item's name, replace them. See [Owner items](#owner-items) |
| `agent-task review <name>` | Record that a running task was handed back for review; its brief and brief sha stay recorded until `stop` or `done` |
| `agent-task list [--started [--brief-under <dir>] \| --owner] [--project <id>] [--full]` | List the running and in-review tasks, oldest started first, flagging each whose brief changed since it started; then the queued tasks `ready` to start and those `waiting`, each by priority, added time and name, running each one's check, whose result `--full` prints as `untilState`; then the owner items, by priority, added time and name. With `--started`, print `counts` and `tasks` alone, reading no queued task and running no check; adding `--brief-under <dir>`, print them only when one's brief sits under that directory, and otherwise refuse `no_brief_under`. With `--owner`, print the owner items alone, grouped by project, and refuse `no_owner_items` when there are none. With `--project`, list only that project's tasks and owner items |
| `agent-task stop <name>` | Take a running or in-review task back to queued, forgetting its brief, session and review time and keeping its goal, plan, priority and waits |
| `agent-task done <name>` | Remove a task in any state, or an owner item, whatever became of its work |
| `agent-task project add <id> --name <text> --repo <path> --dir <dir>` | Add a project: its readable name, its repository's main working tree, and the directory its briefs and plans live in; on an id the store holds, replace them. See [Projects](#projects) |
| `agent-task project list` | List the projects by id |
| `agent-task project remove <id>` | Remove a project, refused `project_in_use` while a task belongs to it |
| `agent-task halt <reason>` | Halt all agent work on this machine, recording the reason and the time; with a halt raised or unreadable, print it unchanged. See [The halt](#the-halt) |
| `agent-task resume` | Lift the halt, the owner's act, printing it as it was, or `none` |
| `agent-task halted` | Print `none` when no halt is raised; while one is, refuse `halted` naming its reason |
| `agent-task doctor [--full]` | Report what agent-task and its plugin need: the store, `bash`, `agent-task`, `jq` and git on `PATH`, each task's repository, each running or in-review task's brief and each plan a task names, each check `ok`, `warn` or `fail` with its fix; exit 1 when one fails |
| `agent-task` | Run `list` with no flag |
| `agent-task --help` | List each command and flag with its usage and summary |
| `agent-task --version` | Print the version alone on one line, not as TOON |

## Default views

`list`, `project list` and `doctor` lead their result with `counts`, then print by default what an agent acts on, as TOON tables. No default field is `null` except the `project` of a task or owner item that belongs to none, and the `project` and `name` of `list --owner`'s unmapped group. On `list` and `doctor`, `--full` prints every field and every check.

| Command | `counts` | Default fields | `--full` adds |
| --- | --- | --- | --- |
| `list` | `running`, `review`, `ready`, `waiting`, `owner` | `halt`, then `tasks{name,project,state,brief,briefChanged}`, `ready{name,project,repo}`, `waiting{name,project,repo}`, `owner{name,project,ask}` | Every field of each task, `reviewed` `null` on a running one, each queued task's goal, plan, priority, waits, `after`, `until` and `untilState`, and each owner item's state, priority and added time |
| `list --started` | `running`, `review` | `tasks{name,project,state,brief,briefChanged}` | Every field of each task |
| `list --owner` | `owner` | `owner`, one group per project with its `project`, `name` and `items{name,project,ask}`, the unmapped last | Each item's state, priority and added time |
| `project list` | `projects` | `projects{id,name,repo,dir}` | Nothing: `--full` is not a flag of it |
| `doctor` | `ok`, `warn`, `fail` | `checks{name,state,detail,fix}` of each check that warns or fails, empty when all pass | The checks that pass, each with a `null` fix |

## Names and waits

- `add` and `start` refuse a name the store holds running or in review.
- `list` flags a running or in-review task whose brief no longer has the sha it started with, or is gone or unreadable.
- A removed name is free to add or start again.
- A task waits after a name only while the store holds it: `done` frees what waited after the name, and `add` of the name again blocks them again.
- `waits` is text for the listing and stops nothing.
- `until` is a shell command recorded as given. `list` runs it as `/bin/sh -c` in the task's repository, under the time limit [SPEC FR-33](../SPEC.md) sets, and `list --full` prints the result as `untilState`: `met` on exit 0, `unmet` on exit 1 through 125, `timed_out`, or `failed` on exit 126 and up, a signal, or a repository that is gone. A task waiting after no held name is ready when its check is met, whatever its `waits`, or when it has no check and no `waits`. `start` drops the check with the task's `after`, and `stop` returns the task to the queue with neither.
- `doctor` contacts no remote and reads no origin.

## Projects

A project groups tasks, so `list --project <id>` shows one project's work alone. Its repository is the project's home, where its coordinator starts; its tasks keep their own repositories, since one project can span several.

- **Added explicitly**: `project add` records a project, and agent-task never infers one from a repository or a directory.
- **Mapped explicitly**: `add`, `start` and `map` name a task's project, refused `unknown_project` for one the store does not hold. `add` of a queued name replaces its project with the one given, or none; `start` of a queued task keeps its project unless `--project` names another.
- **Removed once empty**: `project remove` is refused `project_in_use`, naming each task that belongs to the project, until each is mapped elsewhere or done.

## Owner items

An owner item waits on the owner: a question, or a setup step only the owner can do, held in full as `ask`, in its own state `owner`. It has no repository, since the owner acts on it, not an agent.

- **Never started**: `add`, `start`, `wait`, `review` and `stop` on it are refused `waits_on_owner`, naming its text, `done`, `ask` and `map`.
- **Closed by `done`**: once the owner has answered or acted. A task may wait `--after` an owner item and is `blocked` until then.
- **Listed apart**: `list` prints `owner` after `ready` and `waiting`; `list --owner` prints them alone, grouped by project, and the plugin puts that in every session, as [the plugin doc](plugin.md) says.

## The halt

`agent-task halt "<reason>"` stops all agent work on this machine until the owner runs `agent-task resume`. Anyone may raise it; only the owner lifts it.

- **While raised**: `add`, `start`, `wait`, `map`, `ask`, `project add` and `project remove` are refused `halted`, naming the reason and `resume`; the other commands work.
- **Reported**: `list` prints `halt` after `counts`, as `none`, `raised` with its reason and time, or `unreadable`.
- **Unreadable**: a record that is not a file, or not JSON of a reason and a time, counts as raised. `resume` removes it; one it cannot remove, such as a directory, is refused `halt_unremovable` and stays.
- **In sessions**: the plugin refuses edits, shell commands and agents while a halt is raised, as [the plugin doc](plugin.md#the-halt) says.

## The store

The store lives on this machine, at `$XDG_DATA_HOME/agent-task/tasks.db` (`~/.local/share/agent-task/tasks.db` by default), with the halt, when one is raised, in `halt.json` beside it. A store of schema version 1, 2 or 3, written by an earlier agent-task, is migrated by the first command that opens it, keeping every task it holds; from version 3 it gains the projects and the owner items, holding none.
