# src/

Flat, so a module is found by name. A file's prefix is its module: `cli-output.ts` belongs to `cli`. A module that is one file carries its bare name (`assert.ts`, `coded-error.ts`). A test sits beside its module as `<module>.test.ts`; a file several tests share is `<name>.test-support.ts`, and `test-env.ts` is the environment `bunfig.toml` preloads for every test.

`cli` is the one module of several files, each named for its part:

| File | Holds |
| --- | --- |
| `cli.ts` | The entry: read the command line and the environment, run the command, print its result or refusal and set the exit code |
| `cli-commands.ts` | Every command: parse its arguments, call the domain, return its result |
| `cli-contract.ts` | What a command is, and the usage errors |
| `cli-views.ts` | What `list` and `doctor` print: the `counts` leading each, then `list`'s fields and `doctor`'s checks by default or with `--full` |
| `cli-output.ts` | Writing the result as TOON to stdout and the error to stderr, and exiting |

Another module reaches a module only through its bare-named file, so `cli`'s parts are its own and no module imports the entry. Only the entry reads the environment; it passes what the rest needs. Only `git` and `until` start a process; among the tests, only `cli.test.ts`, which holds the one CLI runner, and the repo fixtures do. A module makes no error but a `CodedError`, and every `switch` ends in a `default` that calls `unreachable`. [`modules.test.ts`](modules.test.ts) holds each of these, and reads the table below for the modules.

## Modules

| Prefix | Responsibility |
| --- | --- |
| `cli` | The `agent-task` command line, over the domain below |
| `tasks` | The domain: `add`, `start`, `wait`, `review`, `list`, `stop` and `done`, the `invalid_name` refusal of a name, the `blocked` refusal of a start, raised from what the store's start statement reports, the `no_brief_under` refusal of a started listing from a directory that holds no started task's brief, and the commands each state admits, which every state refusal names; `add`, `start` and `wait` are refused while a halt is raised, and `list` carries the halt |
| `halt` | The machine-wide halt, a file beside the store: reading it as none, raised with its reason and time, or recorded but unreadable, which counts as raised; raising it once, lifting it, and the `halted` refusal while one is raised |
| `store` | The SQLite store: opening it, its schema and version, the migrations from versions 1 and 2, the `TaskName` and `Priority` types and their rules, and the statements that insert, replace, start, wait, review, stop, remove and read tasks with the names they wait after, returning the row or `null`; the start statement reports the started row or the held names that block it |
| `git` | Run git and read what it prints: a path's main working tree and a file's blob sha |
| `until` | Run a queued task's check, `/bin/sh -c` of the command in the task's repository with the timeout passed in, and say whether it was met, unmet, timed out or failed |
| `doctor` | `doctor`: what agent-task and its plugin need, judged from the store and its version, each task's repository, each running or in-review task's brief, each plan a task names, git and the directories on `PATH`, each check with its state and fix; it writes no task and no schema |
| `paths` | The data directory, the store's path and the halt's, from the environment the entry passes in |
| `file` | `permits`: whether a path is a file this process may open with a given access mode |
| `coded-error` | Usage errors, refusals and faults with a code, their facts and the act that resolves them, and the exit status of each kind |
| `assert` | `unreachable` and `invariant`, faults that name a bug |

## Where to start

- `cli-commands.ts` lists the commands and what each calls.
- `tasks.ts` holds a task's states and the refusal each act meets in each.
- `repo.test-support.ts` builds the throwaway repositories and origins the tests run against.
- `spec.test.ts` ties [`../SPEC.md`](../SPEC.md)'s criteria to the acceptance suite in `../acceptance`, which drives the CLI and the plugin's hooks from outside; `syntax.test-support.ts` walks a source file's syntax for it and for `modules.test.ts`.
