# Development

Checks, scripts and rules, for working on this repo, set up from a clone as the [README](../README.md#from-a-clone) says.

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
