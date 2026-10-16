# agent-task

The running tasks a coordinator of coding agents holds, recorded so they can be listed, checked and closed. [`SPEC.md`](SPEC.md) states what must hold.

## Install

From a clone, with [mise](https://mise.jdx.dev):

```sh
git clone https://github.com/cniska/agent-task.git
cd agent-task
mise trust
mise install
```

`mise install` installs Bun, the dependencies and links `agent-task` onto `PATH`.

## Development

`bun run check` runs lint, typecheck, knip and the tests; `bun run acceptance` runs the acceptance suite. [`AGENTS.md`](AGENTS.md) holds the rules every change follows.
