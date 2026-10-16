# agent-task Specification

> The coding-agent tasks running on one machine, recorded so they can be listed, checked against their briefs and closed against what landed.

This document states what must hold, not how. [`README.md`](README.md) has the install and the commands, and [`src/README.md`](src/README.md) maps the modules that meet these requirements.

## 1. Purpose & context

Coding agents run in parallel on one machine, each on a task started from a brief, a file of instructions for that task. agent-task records each task while it runs: its name, the repository the work lands in, the brief's path, and the git blob sha of the brief's content when the work started. It refuses a second task under a name already used, lists the running tasks and flags one whose brief no longer has that sha or is gone or unreadable, closes a task only once its commits are on origin's default branch, and drops a task whose work was given up. `doctor` reports what agent-task and its plugin need in order to work, with a fix for each failure. The `cniska-task` Claude Code plugin keeps a running task's brief from changing under it, by denying an edit to that brief, and puts the running tasks in a session's context where the session's working directory holds one of their briefs.

**Primary user:** whoever runs coding-agent tasks in parallel on one machine, a person or an agent, and the agents doing those tasks, through the CLI and the plugin. agent-task depends on git alone; it reads no other tool's data, and every command works where no other tool is installed.

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
- **FR-17** — A result is one JSON line on stdout, `{"command":<name>,"ok":true,"result":<value>}`, with exit 0, except that `doctor` exits 1 when a check fails (FR-21): `ok` means the command ran. An error is one JSON line on stderr, `{"command":<name>,"ok":false,"error":{"kind","code","message","meta","resolve"}}`, where `resolve` names the act that resolves it; the exit is 1 for a refusal, 2 for a usage error and 3 for a fault. An unknown command is the usage error `unknown_command`, and a command given a missing, empty, extra or unknown argument is the usage error `bad_arguments`.

### 2.8 The Claude Code plugin

- **FR-18** — Before each `Edit`, `Write` or `MultiEdit`, the `cniska-task` plugin reads the running tasks with `list` and denies the edit when the file it names, resolved to its real path, is the brief of a running task. The denial names the file and the task, says a running task's brief does not change under it, and names the acts in order: `agent-task drop <name> --reason <text>`, then the edit, then `agent-task start <new-name> --repo <repo> --brief <file>` under a name the store has never held, since a dropped name stays taken (FR-9). A brief that is gone, with or without its directory, is still matched by its path, so writing it back is denied too. An edit to a file no running task names as its brief passes without a word.
- **FR-19** — When a session starts, resumes, clears or compacts in a working directory that holds the brief of a running task, the plugin puts the running tasks in the session's context as `list` prints them, `briefChanged` included, with a line saying the plugin denies an edit to a running task's brief. Elsewhere it prints nothing.
- **FR-20** — A hook prints nothing and denies nothing when `agent-task` is not on `PATH`, when `list` is refused, such as `store_version`, or when the hook's input names no file or no directory, and it exits 0 in every case; the hooks deny nothing but the edit FR-18 names. Without `jq` or `realpath` on `PATH`, a hook leaves a note on stderr and nothing else. A hook sees the `PATH` Claude Code started with; [`README.md`](README.md) says how to check that `PATH` with `doctor`.

### 2.9 doctor

- **FR-21** — `doctor` reports its checks, each with a name, a state of `ok`, `warn` or `fail`, a detail and a fix (`null` when it passes), and how many fail; it exits 1 when a check fails and 0 otherwise. It reads only the store, each running task's repository and brief, git and `PATH`: it writes no task and no schema, makes no store where there is none, and contacts no remote.
- **FR-22** — The store check passes when there is no store yet, since `start` creates one, and when the store is of this version; it fails with the refusal's fix when the store is of another version (FR-4), cannot be opened or stays locked. When it fails, no task is checked.
- **FR-23** — `doctor` looks through `PATH` for an executable `bash`, `agent-task`, `jq` and `realpath`, which the plugin's hooks need (FR-20, C-3), and `git`, and runs none of them but git. Each detail names where the program was found, or the directories searched. A missing hook program warns, naming the hooks that go silent without it, since `doctor` cannot tell whether the plugin is installed; a missing git fails.
- **FR-24** — For each running task, oldest first, `doctor` checks its repository in `done`'s order: a repository that is not a directory fails naming `drop` as `repo_missing` does; without git on `PATH` the repository warns as unchecked; one with no `remote.origin.url` fails, as `done` would refuse it `no_origin`; one that is not a checkout git can confirm, or is no longer its own main working tree, warns naming `drop`, since `done` still runs there. Whether origin answers, and whether it names a default branch, stay `done`'s to find. A brief that is not a readable file warns naming `drop`.

### 2.10 The release build

- **FR-25** — `scripts/build-compiled.sh <outfile>` compiles the CLI into one executable that carries the version and SQLite through Bun's driver, so it runs every command with no checkout of agent-task and no Bun on the machine.
- **FR-26** — `install.sh`, run by `curl … | sh`, downloads the latest release's build for this platform, checks it against its published sha256, runs it for its version, and installs it as `~/.local/bin/agent-task`, writing it beside that path and renaming it into place. A download that fails, does not match its checksum, or reports a version that is not `x.y.z` installs nothing. Run again, it replaces the install.
- **FR-27** — The npm package `@cniska/agent-task` installs the build for its platform from `@cniska/agent-task-darwin-arm64` or `@cniska/agent-task-linux-x64`, finds it where `npm` or `bun` installed it, and runs it with the arguments it was given, exiting as it exits, with no `node` or `bun` on `PATH`. On another platform, or with the platform package missing, it refuses with `no_build_for_platform` or `platform_package_missing`; with a platform build that is not executable, with `binary_failed`. Each refusal is the one JSON line on stderr that FR-17 gives an error, exiting 1.

## 3. Non-functional requirements

- **NF-1** — The tests never read or write the real home: `HOME` and the XDG directories point at scratch directories.
- **NF-2** — Every command reads the store, the filesystem and git afresh; nothing is remembered between commands.
- **NF-3** — Every command of the CLI, run from a checkout or as the release binary, runs with git as the only program on `PATH`. The npm package's launcher also needs a POSIX shell and the system's `uname`, `readlink`, `dirname` and `sed` on `PATH`.

## 4. Out of scope

- Worktrees: agent-task never creates, reads or checks one; a task may share its worktree's name.
- A record of agent sessions, notes on how a task is going, and a backlog of work not yet started.
- Showing one task, listing done or dropped tasks, who acted, experiments, dependencies, priority and a UI.

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
- **AC-14** — No command and `--help`: the same one JSON line listing `start`, `list`, `done`, `drop` and `doctor` and the `--version` flag, exit 0. (FR-16)
- **AC-15** — An unknown command, and `start` with no `--brief`: exit 2, nothing on stdout, `unknown_command` naming it and `bad_arguments` with the usage as the act; a refusal exits 1. (FR-17)
- **AC-16** — The test environment's `HOME` and XDG directories are scratch directories, not the account's. (NF-1)
- **AC-17** — With only git on `PATH`: `start`, `list`, `done` and `drop` each succeed, and `doctor` exits 0 with git `ok` naming where it was found and `bash`, `agent-task`, `jq` and `realpath` each `warn` naming the directory searched and both hooks. (NF-3, FR-23)
- **AC-18** — Run the `PreToolUse` hook as `hooks.json` registers it, from the plugin `plugin.json` names `cniska-task`, with only a shell, bash, git, `jq`, `realpath` and `agent-task` on `PATH`, with `task-a` running on a brief: an `Edit`, a `Write` and a `MultiEdit` naming the brief, by its absolute path and by a path relative to the hook's working directory: each denied, the reason naming the brief, `agent-task drop task-a --reason`, the edit and `agent-task start` under a new name; a `Write` to the brief's path after the brief is deleted, and after its directory is deleted: denied; naming another file in the same directory, a file that does not exist, and a relative path with no `cwd` in the input: exit 0 printing nothing. (FR-18, FR-20)
- **AC-19** — Run the `SessionStart` hook as `hooks.json` registers it, with the same `PATH`, with two tasks running on briefs under one directory, one brief amended since: from that directory and from its parent, exit 0 printing the context with both tasks as `list` prints them, the amended one flagged; from a sibling directory with no brief, from the directory of a dropped task's brief, and from a directory that does not exist: exit 0 printing nothing. The hooks file matches the edit hook on `Edit|Write|MultiEdit` and the session hook on the four session sources. (FR-19, FR-20)
- **AC-20** — With a store of another schema version, as AC-12 sets up: the `PreToolUse` hook on the brief and the `SessionStart` hook from its directory each exit 0 printing nothing; with no `agent-task` on `PATH`: the same; with `jq`, and with `realpath`, off `PATH`: each exits 0 with nothing on stdout and one `cniska-task:` line on stderr naming the missing program. (FR-20)
- **AC-21** — `doctor` with no store, and `bash`, git, `jq`, `realpath` and `agent-task` on `PATH`: one JSON line on stdout with `ok` true, every check `ok` with a `null` fix, none failing, exit 0, and still no store; with a store of another schema version, as AC-12 sets up: the store check fails with `store_version`'s fix, one failing, exit 1 with `ok` true, and the file unchanged. (FR-17, FR-21, FR-22)
- **AC-22** — `doctor` with no git on `PATH` and a task running: git fails, the task's repository warns as unchecked, and the exit is 1. (FR-23, FR-24)
- **AC-23** — `doctor` with five tasks running: one in a repository whose origin is a path that does not exist, one in a repository with no origin, one whose repository moved, one whose repository is a directory inside a checkout with an origin, and one whose brief was deleted: the first `ok`, which shows no remote was contacted; no origin fails with `no_origin`'s act; the moved one fails naming `drop`; the one inside another checkout warns naming `drop`; the deleted brief warns naming `drop`; two failing, exit 1. (FR-21, FR-24)
- **AC-24** — Compile the release binary and run it with only its own directory and git on `PATH`: `--version` prints the version, and in a scratch repository with a made-up brief `start`, `list`, `drop` and `doctor` each succeed, `doctor` with no failing check. (FR-25, NF-3)
- **AC-25** — Run `install.sh` in a fresh home against a stand-in for the release downloads, twice, then once with a wrong checksum in another fresh home, then against builds that report an empty version, `1.2.3.4` and `../x`: the installed `agent-task --version` prints the release's version and `~/.local/bin` holds only it, and the bad download and each mislabelled build are refused with nothing written. (FR-26)
- **AC-26** — Build the npm packages from a release build, install the shim into a prefix and run it with git and the system's shell utilities on `PATH` and no `node` or `bun`, first on a platform with no build, then without its platform package, then with it unexecutable, then whole: the first is refused as `no_build_for_platform`, the second as `platform_package_missing`, the third as `binary_failed`; then `--version` prints the package version, `--version now` exits 2 with the build's `wrong_arity` usage refusal, and in a scratch repository with a made-up brief `start`, `list`, `drop` and `doctor` each succeed, `doctor` with no failing check. (FR-27, NF-3)

## 6. Deliverables

- **D-1** — The `agent-task` CLI, run by Bun from a checkout through `bin/agent-task` and linked onto `PATH` by `mise install` in the primary checkout; and beside it the release binary `scripts/build-compiled.sh` compiles, for darwin-arm64 and linux-x64, shipped by a GitHub release with `install.sh`, by the npm packages and by the `cniska/tap` Homebrew formula, as [`docs/releasing.md`](docs/releasing.md) says.
- **D-2** — `README.md`, `AGENTS.md`, `src/README.md`, `docs/releasing.md` and this spec.
- **D-3** — The test suite, run by `bun run check`, and the acceptance suite, run by `bun run acceptance`, whose test names cite the criteria in §5. The acceptance suite drives the CLI, the plugin's hooks as its `hooks.json` registers them, the compiled release binary, `install.sh` against a stand-in for the release downloads, and the npm packages through their launcher, from outside.
- **D-4** — The `cniska-task` Claude Code plugin in `plugin/`.

## 7. Constraints (fixed)

- **C-1** — TypeScript on Bun, which mise installs, with SQLite through Bun's own driver.
- **C-2** — git is the one program the CLI runs, from a checkout or as the release binary. The npm package's launcher runs `uname`, `readlink`, `dirname` and `sed` before it hands over to the CLI.
- **C-3** — The plugin brings neither Bun nor the CLI. Its hooks are shell that runs with a POSIX shell, bash, `jq`, `realpath` and `agent-task` alone, and they read the store only through the CLI.
