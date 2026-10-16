# src/

Flat, so a module is found by name. A file's prefix is its module: `cli-output.ts` belongs to `cli`. A module that is one file carries its bare name (`assert.ts`, `coded-error.ts`). A test sits beside its module as `<module>.test.ts`; a file several tests share is `<name>.test-support.ts`, and `test-env.ts` is the environment `bunfig.toml` preloads for every test.

`cli` is the one module of several files, each named for its part:

| File | Holds |
| --- | --- |
| `cli.ts` | The entry: read the command line and the environment, run the command, print its result or refusal and set the exit code |
| `cli-commands.ts` | Every command: parse its arguments, call the domain, return its result |
| `cli-contract.ts` | What a command is, and the usage errors |
| `cli-output.ts` | Writing the JSON result line to stdout and the error line to stderr, and exiting |

Another module reaches a module only through its bare-named file, so `cli`'s parts are its own and no module imports the entry. Only the entry reads the environment; it passes what the rest needs. Only `git` starts a process; among the tests, only `cli.test.ts`, which holds the one CLI runner, and the repo fixtures do. A module makes no error but a `CodedError`, and every `switch` ends in a `default` that calls `unreachable`. [`modules.test.ts`](modules.test.ts) holds each of these, and reads the table below for the modules.

## Modules

| Prefix | Responsibility |
| --- | --- |
| `cli` | The `agent-task` command line |
| `coded-error` | Usage errors, refusals and faults with a code, their facts and the act that resolves them, and the exit status of each kind |
| `assert` | `unreachable` and `invariant`, faults that name a bug |

## Where to start

- `cli-commands.ts` lists the commands and what each calls.
- `spec.test.ts` ties [`../SPEC.md`](../SPEC.md)'s criteria to the acceptance suite in `../acceptance`, which drives the CLI alone; `syntax.test-support.ts` walks a source file's syntax for it and for `modules.test.ts`.
