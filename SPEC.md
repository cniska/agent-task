# agent-task Specification

> The coding-agent tasks running on one machine, recorded so they can be listed, checked against their briefs and closed against what landed.

This document states what must hold, not how. [`README.md`](README.md) has the install and the commands, and [`src/README.md`](src/README.md) maps the modules that meet these requirements.

## 1. Purpose & context

Coding agents run in parallel on one machine, each on a task started from a brief, a file of instructions for that task. agent-task records each task while it runs: its name, the repository the work lands in, the brief's path, and the git blob sha of the brief's content when the work started. It refuses a second task under a name already used, lists the running tasks and flags one whose brief no longer has that sha or is gone or unreadable, closes a task only once its commits are on origin's default branch, and drops a task whose work was given up.

**Primary user:** whoever runs coding-agent tasks in parallel on one machine, a person or an agent, and the agents doing those tasks, through the CLI. agent-task depends on git alone; it reads no other tool's data, and every command works where no other tool is installed.

## 2. Functional requirements

### 2.1 The store

- **FR-1** — Tasks live in one SQLite database, `$XDG_DATA_HOME/agent-task/tasks.db`, created with its directory on first use. The store is machine-local and holds a brief's path and sha, never the brief itself, which stays where it is.
- **FR-2** — An `XDG_DATA_HOME` that is unset, empty or not an absolute path counts as `$HOME/.local/share`.
- **FR-3** — A task's name is unique in the store by a database constraint, so of several `start`s of one name at once, exactly one succeeds and the rest are refused `name_taken`.
- **FR-4** — A store of another schema version is refused `store_version` and left as it is.

### 2.2 Names and states

- **FR-5** — A task name is kebab-case: lowercase letters and digits in words joined by single dashes. Any other name is refused `invalid_name`.
- **FR-6** — A task is `running` from `start` until `done` or `drop` ends it; `done` and `dropped` are final. A command on a task in a state that does not admit it is refused `not_running`, and one on a name the store does not hold is refused `unknown_task`, naming `start`. Each of these refusals names the task's state and the commands that state admits: `done` and `drop` for a running task, none for an ended one.

### 2.3 start

- **FR-7** — `start <name> --repo <path> --brief <file>` records a running task: the repository's main working tree as an absolute real path, whether `<path>` is that checkout, a directory inside it or one of its linked worktrees; the brief's absolute real path; the git blob sha of the brief's content; and the time. It prints the task.
- **FR-8** — A `<path>` whose main working tree git cannot confirm, such as a path outside git, a bare repository, a submodule or a checkout with a separate git dir, is refused `not_a_checkout`, naming the path and the main working tree it would have been. A `<file>` that is not a readable file is refused `brief_unreadable`.
- **FR-9** — A name the store holds in any state is refused `name_taken`, naming its state and what that state admits; the task it names is unchanged.

### 2.4 list

- **FR-10** — `list` prints the running tasks, oldest first, each with its name, repository, brief, brief sha, start time and `briefChanged`: true when the brief's content no longer has the sha it started with, or the brief is gone or cannot be read.

### 2.5 done

- **FR-11** — `done <name> --commit <sha>...` reads origin's default branch from origin, fetches it, and closes the running task when every given sha names a commit reachable from that branch. It records each commit's full sha once, in the order given, and prints the task.
- **FR-12** — A `--commit` value that is not a sha, 4 to 40 hex digits in either case, such as a branch name or `HEAD`, is refused `invalid_sha`, naming each such value, before git runs. A sha that names no commit in the repository after the fetch, or a commit not reachable from the branch, is refused `not_landed`, naming each sha in its own list; the task stays running. A squash or rebase merge makes new commits, so the shas to pass are the ones on the branch.
- **FR-13** — A task whose repository is gone is refused `repo_missing`, naming `drop`; a repository with no remote named origin is refused `no_origin`; an origin whose `HEAD` names no branch is refused `no_default_branch`; and an origin that cannot be read, or does not answer within 60 seconds, is refused `remote_unreachable`. git's own credential prompt is off. The task stays running after each.

### 2.6 drop

- **FR-14** — `drop <name> --reason <text>` ends a running task as dropped, recording the reason and the time, and prints the task.

### 2.7 Output and the version

- **FR-15** — `--version` prints the version alone on one line and exits 0; `--version` with an argument is a usage error.
- **FR-16** — No command, or `--help`, prints one JSON line `{"command":"agent-task","ok":true,"result":{"commands":[...],"flags":[...]}}` listing each command's and flag's name, usage and summary, and exits 0.
- **FR-17** — A result is one JSON line on stdout, `{"command":<name>,"ok":true,"result":<value>}`, with exit 0. An error is one JSON line on stderr, `{"command":<name>,"ok":false,"error":{"kind","code","message","meta","resolve"}}`, where `resolve` names the act that resolves it; the exit is 1 for a refusal, 2 for a usage error and 3 for a fault. An unknown command is the usage error `unknown_command`, and a command given a missing, empty, extra or unknown argument is the usage error `bad_arguments`.

## 3. Non-functional requirements

- **NF-1** — The tests never read or write the real home: `HOME` and the XDG directories point at scratch directories.
- **NF-2** — Every command reads the store, the filesystem and git afresh; nothing is remembered between commands.
- **NF-3** — Every command runs with git as the only program on `PATH`.

## 4. Out of scope

- Worktrees: agent-task never creates, reads or checks one; a task may share its worktree's name.
- A record of agent sessions, notes on how a task is going, and a backlog of work not yet started.
- Showing one task, listing done or dropped tasks, who acted, experiments, dependencies, priority and a UI.
- A release build, an installer and packages.

## 5. Acceptance criteria

- **AC-1** — `start task-a` in a repository with a brief: the task printed with the repository, the brief, its blob sha and the time, and the store at `$XDG_DATA_HOME/agent-task/tasks.db`; `list` prints it with `briefChanged` false. (FR-1, FR-7, FR-10)
- **AC-2** — With `XDG_DATA_HOME` unset, empty and relative: the store is at `$HOME/.local/share/agent-task/tasks.db`. (FR-1, FR-2)
- **AC-3** — `start` from a directory inside the repository and from a linked worktree: each records the main working tree; remove the worktree, push its commit to origin's default branch, and `done` closes the task. (FR-7, FR-11)
- **AC-4** — `start` on a path outside git, a bare repository and a submodule: `not_a_checkout`, and `list` stays empty. (FR-8)
- **AC-5** — `start` with names in each invalid form, with a missing brief, an unreadable brief and a directory as the brief: `invalid_name` and `brief_unreadable`, and `list` stays empty. (FR-5, FR-8)
- **AC-6** — `start` of a name that is running, done and dropped: `name_taken` naming each state, `done` and `drop` for the running one and nothing for the others; `list` still prints the running one unchanged. (FR-6, FR-9)
- **AC-7** — Several `start`s of one name at once, each from its own repository: exactly one succeeds, the rest are `name_taken`, and `list` prints the one. (FR-3)
- **AC-8** — Three running tasks and a dropped one; amend one brief and delete another between two `list`s: the second prints the three running tasks oldest first, flagging the amended and the deleted brief. (FR-10, NF-2)
- **AC-9** — `done` with a pushed commit given both abbreviated and in full: the task done with the full sha once, and gone from `list`. `done` with a pushed, an unpushed and an unknown sha: `not_landed` naming the unknown and the unpushed in their lists, the task still running; `done` with `HEAD` and with `origin/main`: `invalid_sha` naming it, the task still running; push, and the same `done` without the unknown sha closes it. (FR-11, FR-12)
- **AC-10** — `done` in a repository with no origin, with an origin that does not exist, with an origin whose `HEAD` names a missing branch, and after the repository moved: `no_origin`, `remote_unreachable`, `no_default_branch` and `repo_missing` naming `drop`; the task still running after each. (FR-13)
- **AC-11** — `drop` with a reason: the task dropped with its reason; `drop` and `done` on it again: `not_running` naming no command; `drop` of an unknown name: `unknown_task` naming `start`; `drop` and `done` of an invalid name: `invalid_name`. (FR-5, FR-6, FR-14)
- **AC-12** — A store whose schema version is another: `list` refuses `store_version`, and the file is unchanged. (FR-4)
- **AC-13** — `--version`, then `--version now`: the version alone on stdout with exit 0 and nothing on stderr, then exit 2 with `wrong_arity` and the usage as the act. (FR-15, FR-17)
- **AC-14** — No command and `--help`: the same one JSON line listing `start`, `list`, `done` and `drop` and the `--version` flag, exit 0. (FR-16)
- **AC-15** — An unknown command, and `start` with no `--brief`: exit 2, nothing on stdout, `unknown_command` naming it and `bad_arguments` with the usage as the act; a refusal exits 1. (FR-17)
- **AC-16** — The test environment's `HOME` and XDG directories are scratch directories, not the account's. (NF-1)
- **AC-17** — With only git on `PATH`: `start`, `list`, `done` and `drop` each succeed. (NF-3)

## 6. Deliverables

- **D-1** — The `agent-task` CLI, run by Bun from a checkout through `bin/agent-task` and linked onto `PATH` by `mise install` in the primary checkout.
- **D-2** — `README.md`, `AGENTS.md`, `src/README.md` and this spec.
- **D-3** — The test suite, run by `bun run check`, and the acceptance suite, run by `bun run acceptance`, whose test names cite the criteria in §5.

## 7. Constraints (fixed)

- **C-1** — TypeScript on Bun, which mise installs, with SQLite through Bun's own driver.
- **C-2** — git is the one program agent-task runs.
