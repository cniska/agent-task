# Commands

The `agent-task` commands, their flags and output, and the store they read and write. [`SPEC.md`](../SPEC.md) states what must hold.

Each command prints [TOON](https://toonformat.dev): a result on stdout, or an error on stderr naming the act that resolves it, each beside the command's name and `ok`. The [update line](#the-update-check) may come before either, on stderr.

| Command | Does |
| --- | --- |
| `agent-task add <name> --repo <path> --goal <text> [--project <id>] [--plan <file>] [--priority urgent\|high\|medium\|low] [--after <name>]... [--waits <text>] [--until <command>]` | Queue a task under a kebab-case name: its repository, goal, project, plan, priority, the tasks it waits after, what else it waits for and the check that says its wait is met; on a queued name, replace them |
| `agent-task start <name> --repo <path> --brief <file> [--project <id>] [--session <id>]` | Run a task, new or queued, recording its repository, its brief with the brief's sha, the session and, when given, its project; refused `blocked` while a task it waits after is still held, and `machine_busy` while the machine is too busy. See [A busy machine](#a-busy-machine) |
| `agent-task wait <name> [--after <name>]... [--waits <text>] [--until <command>]` | Replace what a task waits for: tasks to land and a check that says the wait is met, on a queued task, and anything else as text; with none of the three, clear all three |
| `agent-task map <name> --project <id>` | Make a task in any state belong to a project the store holds |
| `agent-task priority <name> urgent\|high\|medium\|low\|none` | Set the priority of a task in any state, or with `none` clear it, keeping every other field |
| `agent-task review <name>` | Record that a running task was handed back for review; its brief and brief sha stay recorded until `stop` or `done` |
| `agent-task list [--started [--brief-under <dir>]] [--project <id>] [--full]` | List the running and in-review tasks, oldest started first, flagging each whose brief changed since it started; then the queued tasks `ready` to start and those `waiting`, each by priority, added time and name, running each one's check, whose result `--full` prints as `untilState`. With `--started`, print `counts` and `tasks` alone, reading no queued task and running no check; adding `--brief-under <dir>`, print them only when one's brief sits under that directory, and otherwise refuse `no_brief_under`. With `--project`, list only that project's tasks |
| `agent-task stop <name>` | Take a running or in-review task back to queued, forgetting its brief, session and review time and keeping its goal, plan, priority and waits |
| `agent-task done <name>` | Remove a task in any state, whatever became of its work |
| `agent-task project add <id> --name <text> --repo <path> --dir <dir>` | Add a project: its readable name, its repository's main working tree, and the directory its briefs and plans live in; on an id the store holds, replace them. See [Projects](#projects) |
| `agent-task project list` | List the projects by id |
| `agent-task project remove <id>` | Remove a project, refused `project_in_use` while a task belongs to it |
| `agent-task halt <reason>` | Halt all agent work on this machine, recording the reason and the time; with a halt raised or unreadable, print it unchanged. See [The halt](#the-halt) |
| `agent-task resume` | Lift the halt, the owner's act, printing it as it was, or `none` |
| `agent-task halted` | Print `none` when no halt is raised; while one is, refuse `halted` naming its reason |
| `agent-task check '<command>'` | Run a test, check, verify, lint, typecheck or build with `/bin/sh`, once no other check on this machine runs and the machine is under its limits, passing its output and exit code through. See [Checks](#checks) |
| `agent-task gate '<command>'` | Print `gated` when a shell command runs no check but through `check`; otherwise refuse `check_ungated`, naming the `check` command to run instead |
| `agent-task doctor [--full]` | Report what agent-task and its plugin need: the store, `bash`, `agent-task`, `jq` and git on `PATH`, each task's repository, each running or in-review task's brief and each plan a task names, each check `ok`, `warn` or `fail` with its fix; exit 1 when one fails |
| `agent-task` | Run `list` with no flag |
| `agent-task --help` | List each command and flag with its usage and summary |
| `agent-task --version` | Print the version alone on one line, not as TOON |

## Default views

`list`, `project list` and `doctor` lead their result with `counts`, then print by default what an agent acts on, as TOON tables. No default field is `null` except the `project` of a task that belongs to none. On `list` and `doctor`, `--full` prints every field and every check.

| Command | `counts` | Default fields | `--full` adds |
| --- | --- | --- | --- |
| `list` | `running`, `review`, `ready`, `waiting` | `halt`, then `tasks{name,project,state,brief,briefChanged}`, `ready{name,project,repo}`, `waiting{name,project,repo}` | Every field of each task, `reviewed` `null` on a running one, and each queued task's goal, plan, priority, waits, `after`, `until` and `untilState` |
| `list --started` | `running`, `review` | `tasks{name,project,state,brief,briefChanged}` | Every field of each task |
| `project list` | `projects` | `projects{id,name,repo,dir}` | Nothing: `--full` is not a flag of it |
| `doctor` | `ok`, `warn`, `fail` | `checks{name,state,detail,fix}` of each check that warns or fails, empty when all pass | The checks that pass, each with a `null` fix |

## Names and waits

- `add` and `start` refuse a name the store holds running or in review.
- `list` flags a running or in-review task whose brief no longer has the sha it started with, or is gone or unreadable.
- A removed name is free to add or start again.
- A task waits after a name only while the store holds it: `done` frees what waited after the name, and `add` of the name again blocks them again.
- `waits` is text for the listing and stops nothing.
- `until` is a shell command recorded as given. `list` runs it as `/bin/sh -c` in the task's repository, under the time limit [SPEC FR-33](../SPEC.md) sets, and `list --full` prints the result as `untilState`: `met` on exit 0, `unmet` on exit 1 through 125, `timed_out`, or `failed` on exit 126 and up, a signal, or a repository that is gone. A task waiting after no held name is ready when its check is met, whatever its `waits`, or when it has no check and no `waits`. `start` drops the check with the task's `after`, and `stop` returns the task to the queue with neither.
- `doctor` contacts no git remote and reads no origin.

## Projects

A project groups tasks, so `list --project <id>` shows one project's work alone. Its repository is the project's home, where its coordinator starts; its tasks keep their own repositories, since one project can span several.

- **Added explicitly**: `project add` records a project, and agent-task never infers one from a repository or a directory.
- **Mapped explicitly**: `add`, `start` and `map` name a task's project, refused `unknown_project` for one the store does not hold. `add` of a queued name replaces its project with the one given, or none; `start` of a queued task keeps its project unless `--project` names another.
- **Removed once empty**: `project remove` is refused `project_in_use`, naming each task that belongs to the project, until each is mapped elsewhere or done.

## The halt

`agent-task halt "<reason>"` stops all agent work on this machine until the owner runs `agent-task resume`. Anyone may raise it; only the owner lifts it.

- **While raised**: `add`, `start`, `wait`, `map`, `priority`, `project add`, `project remove` and `check` are refused `halted`, naming the reason and `resume`; the other commands work.
- **Reported**: `list` prints `halt` after `counts`, as `none`, `raised` with its reason and time, or `unreadable`.
- **Unreadable**: a record that is not a file, or not JSON of a reason and a time, counts as raised. `resume` removes it; one it cannot remove, such as a directory, is refused `halt_unremovable` and stays.
- **In sessions**: the plugin refuses edits, shell commands and agents while a halt is raised, as [the plugin doc](plugin.md#the-halt) says.

## A busy machine

`start` refuses to start a task while the machine is too busy for another one, whatever is keeping it busy, so agents never pile work onto a busy machine. Of the other commands, only [`check`](#checks) reads the machine, and it waits rather than refusing.

- **CPU**: refused while the 1-minute load average divided by the machine's CPU cores is above `maxLoadPerCore`, by default 0.7, which is about 10 on 14 cores.
- **Memory**: refused while the share of physical memory available to a new process is below `minAvailableMemory`, by default 0.15. Available memory is what the operating system can give a new process without swapping, reclaimable cache included: `MemAvailable` in `/proc/meminfo` on Linux, and the `kern.memorystatus_level` sysctl on macOS.
- **Any machine**: both readings come from the operating system on every `start`, so the check needs nothing set up on macOS or Linux.
- **The refusal**: `machine_busy` names each reading, each limit, which reading passed its limit and the limits file, and says to start nothing now and retry once the machine is less busy:

  ```text
  command: start
  ok: false
  error:
    kind: refusal
    code: machine_busy
    message: "this machine is too busy to start another task: the 1-minute load average is 10.5 on 14 cores, 0.75 per core, above the limit of 0.7"
    meta:
      name: task-a
      over[1]: load
      load:
        average: 10.5
        cores: 14
        perCore: 0.75
        limit: 0.7
      memory:
        available: 0.86
        limit: 0.15
      path: /Users/me/.local/share/agent-task/limits.json
    resolve: "start nothing now; retry agent-task start task-a --repo <path> --brief <file> [--project <id>] [--session <id>] once the machine is less busy; only the owner changes this machine's limits, in /Users/me/.local/share/agent-task/limits.json"
  ```

- **No way past it**: no flag sets a limit or a reading, and the limits are read from beside the store, so a start made under another `XDG_DATA_HOME` reaches only another store. The owner changes the machine's limits instead.

The limits are the machine's own, never the repo's, in `limits.json` beside the store, at `$XDG_DATA_HOME/agent-task/limits.json` (`~/.local/share/agent-task/limits.json` by default). Each is optional and takes its default when unset:

```json
{ "maxLoadPerCore": 0.7, "minAvailableMemory": 0.15 }
```

`maxLoadPerCore` is a number of at least 0, and `minAvailableMemory` a share of physical memory from 0 to 1. A file that is not such an object is refused `limits_unreadable` by `start` and `check`, naming the file and why.

## Checks

`agent-task check '<command>'` runs an agent's test, check, verify, lint, typecheck or build so that only one runs at a time across the machine, and only while the machine is under [its limits](#a-busy-machine). Checks run in parallel by several agents, beside the owner's own work, have frozen the machine.

- **The slot**: `check` takes the machine's one check slot, a lock on `check.lock` beside the store, waiting while another check holds it.
- **The machine**: holding the slot, it waits while a reading is over its limit, as `start` reads them.
- **The run**: it then runs the command with `/bin/sh -c` in the working directory, passing its input, output and exit code through, or 128 plus the signal's number when a signal ends it. It prints no result of its own.
- **Freed when the check ends**: the check inherits the lock, so the slot is free once the check and every process still holding it end, however each ends. Killing agent-task alone frees nothing its check still holds, and a waiter then names the slot's file, so `lsof` finds what still holds it.
- **The halt**: refused `halted` while a halt is raised, before it waits, while it waits and before it runs.
- **No way past it**: `check` takes one command and no flag. A check under another `XDG_DATA_HOME` takes only another store's slot.

While it waits, `check` prints a line on stderr naming what it waits on, and again only when that changes:

```text
agent-task check: waiting for the check slot, held by process 4242 since 2026-11-13T13:20:00.000Z, running mise run check in /Users/me/code/app
agent-task check: waiting for the check slot, held by a process left running by the check mise run check in /Users/me/code/app, which process 4242 started at 2026-11-13T13:20:00.000Z and which has ended; lsof /Users/me/.local/share/agent-task/check.lock names the holder
agent-task check: waiting for the machine, since the 1-minute load average is 12.3 on 14 cores, 0.88 per core, above the limit of 0.7
```

A long wait can outlast an agent tool's time limit, so an agent runs a check in the background. The plugin refuses a check run any other way, as [the plugin doc](plugin.md#the-check-gate) says. `agent-task gate '<command>'` is what it asks: it lists the checks a shell command runs outside `check`, as [SPEC FR-57](../SPEC.md) defines them, wherever they sit in the command. A command that never ends, such as a dev server or a watcher, is no check.

## The update check

agent-task tells the agent running it when a newer release is out on the channel it was installed through. Before any command, it prints one line on stderr, then the command's own output:

```text
agent-task 0.3.1 is out (running 0.3.0): run brew upgrade agent-task; if you cannot, tell the user.
```

- **Channel**: read from where the binary sits, through Homebrew, npm, Bun or the curl installer. A checkout's or a hand-placed binary is on no channel and never checks.
- **Latest**: what that channel serves: the tap's formula, the npm registry's `latest` tag, or the latest GitHub release.
- **Once a day**: agent-task asks at most once a day, for up to a second. A check that fails or times out counts as that day's check and adds no line of its own; a newer version already known still prints.
- **Every command**: the line prints on each command while the latest version known is newer, whether or not that command asked.
- **Unchanged**: stdout and the exit code are as they would be without the line.
- **Off**: no check runs and no line prints while `CI` or `AGENT_TASK_NO_UPDATE_CHECK` is set and not blank. The plugin's hooks set the second.

The check keeps the time it asked and each channel's latest version in `$XDG_STATE_HOME/agent-task/update-check.json` (`~/.local/state/agent-task/update-check.json` by default).

## The store

The store lives on this machine, at `$XDG_DATA_HOME/agent-task/tasks.db` (`~/.local/share/agent-task/tasks.db` by default), with the halt, when one is raised, in `halt.json` beside it, the machine's limits, when the owner sets them, in `limits.json`, and the check slot in `check.lock`. A store of schema version 1, 2, 3 or 4, written by an earlier agent-task, is migrated by the first command that opens it, keeping every task it holds; from version 3 it gains the projects, holding none, and from version 4 it drops any owner item, which an unreleased agent-task recorded.
