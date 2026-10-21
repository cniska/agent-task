# Development

Setup, checks, scripts and rules, for working on this repo.

## Setup

agent-task runs on [Bun](https://bun.sh), which [mise](https://mise.jdx.dev) installs for it. With mise installed:

```bash
git clone https://github.com/cniska/agent-task.git
cd agent-task
mise trust && mise install
```

- `mise install` installs Bun and the dependencies, and the `bun install` its postinstall runs calls the `prepare` script, which points `core.hooksPath` at `.githooks/`. Only in the clone, never in a worktree, does it put `agent-task` in `~/.bun/bin` with `bun link`, so removing a worktree never leaves the command pointing at a deleted checkout. Add `~/.bun/bin` to your `PATH` if it is not there yet.
- `bin/agent-task` finds Bun through mise in `$MISE_DATA_DIR`, or `~/.local/share/mise` when that is unset, never through `XDG_DATA_HOME`, so a test or command that points `XDG_DATA_HOME` at a scratch directory still runs the CLI; `scripts/source-launcher.test.ts`, in the check, holds this. If you set `XDG_DATA_HOME` for your whole shell, set `MISE_DATA_DIR` to where mise keeps its installs.
- `.worktree-hooks/setup` sets up a task worktree the same way, without linking the CLI.
- `.githooks/` holds the commit-subject, format and no-comments gates, and runs `bun run check` before each commit.

## Checks

- `bun run check` runs lint, typecheck, knip and the tests.
- `bun run acceptance` runs the acceptance suite. Each acceptance test gets 20 seconds rather than Bun's default 5, since one drives git and the CLI many times and under heavy load took longer than 5; the release criteria, which compile the binary, set their own 60.
- `npm/agent-task` is the npm package's launcher, a POSIX shell script `scripts/build-npm.ts` fills with the release builds; `scripts/launcher.test.ts`, in the check, runs it over the layouts `npm` and `bun` install, with no runtime on `PATH`.

## Release scripts

- `scripts/build-compiled.sh <outfile>` compiles the CLI into one executable that needs no Bun, the binary a release ships.
- `scripts/smoke.sh <executable> <version>` is the release's smoke test: the executable prints the version, runs `start`, `list` and `done` on a made-up brief in a scratch repository and passes `doctor` there; the release runs it on each build and on each registry install.
- `scripts/release.sh patch|minor|major` bumps the version and tags it; `.github/workflows/release.yml` builds the tag into an attested GitHub release, published only once every file is attached, the npm packages with provenance and a Homebrew repin, as [Releasing](releasing.md) says.

## Rules

[`AGENTS.md`](../AGENTS.md) holds the rules every change follows, [`SPEC.md`](../SPEC.md) states what must hold, and [`src/README.md`](../src/README.md) maps the modules.
