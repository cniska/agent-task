# Releasing

agent-task releases through agent-ship: a `v*` tag on `main` runs `.github/workflows/release.yml`, which only calls agent-ship's reusable release workflow, pinned by the full sha of an agent-ship release. It holds the concurrency group `release-<ref>`, so a second run of one tag waits for the first. [`ship.toml`](../ship.toml) names the channels, and agent-ship's [`docs/releasing.md`](https://github.com/cniska/agent-ship/blob/main/docs/releasing.md) says what the workflow does with each.

| Channel | What `ship.toml` gives it |
| --- | --- |
| `github-release` | `scripts/build-release.sh`, run once per target, which writes that target's tarball and `.sha256` to `dist/`, and an `assemble` that adds `install.sh` and `SHA256SUMS.txt`; the workflow attests every file, creates the tag's release as a draft with all of them, and only then publishes it |
| `npm` | `scripts/build-npm.ts`, which builds the three packages from the release's tarballs, and the smoke `scripts/smoke.sh`; the workflow publishes the packages with provenance, then installs `@cniska/agent-task` and runs the smoke, as [What a release tests](#what-a-release-tests) says |
| `homebrew` | `cniska/homebrew-tap` and `Formula/agent-task.rb`; once the release is published, the workflow dispatches the tap to repin the formula, with `TAP_DISPATCH_TOKEN` |

A release never updates itself. Each channel updates the way it installed: `brew upgrade agent-task`, `npm update -g @cniska/agent-task`, `bun update -g @cniska/agent-task`, or the curl line run again.

## What a release tests

- **The build.** The workflow runs `scripts/build-release.sh` once per target, darwin-arm64 on a macOS runner and linux-x64 on a Linux one. Each run compiles its own target and runs `scripts/smoke.sh` on it, as [Development](development.md#release-scripts) says.
- **The npm install.** Once the packages are published, the workflow installs `@cniska/agent-task` from the registry on a macOS and a Linux runner, through `npm` and through `bun`. On each install it runs `scripts/smoke.sh` for the version under release, with neither Node nor Bun on `PATH`. `scripts/launcher.test.ts`, in the check, runs the launcher over the layouts `npm` and `bun` install, with no runtime on `PATH`.
- **A dry run.** `gh workflow run release.yml -R cniska/agent-task --ref main` runs the release without publishing. It builds and smoke-tests each target, makes every release file and packs the npm packages. It attests, publishes and dispatches nothing.

## What a release guarantees

- **Built by agent-ship's workflow from the tag.** Each file the release attaches carries a build provenance attestation, signed through Sigstore by the tag's run. The signer is agent-ship's reusable workflow, which `release.yml` calls. With [`gh`](https://cli.github.com), `gh attestation verify <file> -R cniska/agent-task --signer-workflow cniska/agent-ship/.github/workflows/release.yml --source-ref refs/tags/<tag>` proves that workflow built the file from agent-task's tagged commit. Adding `--signer-digest` with the sha `release.yml` pins also proves which agent-ship commit built it.
- **Unchanged since it was published.** With release immutability on, GitHub locks a published release's files and its tag and records a release attestation of its tag, commit and files. `gh release verify <tag>` proves the release is immutable, and `gh release verify-asset <tag> <file>` proves a local file is the one the release published. Both hold only for a release published after the setting was turned on; GitHub never makes an earlier release immutable. The tap is dispatched only once the release is published, so the formula pins files that, with the setting on, cannot change.
- **Matches its checksum.** `install.sh` checks each tarball against its `.sha256` from the same release, which catches a broken download, not a changed release, and runs neither check above, since a curl install cannot assume `gh`.

## The owner's setup, once

1. On npmjs.com, give each of `@cniska/agent-task-darwin-arm64`, `@cniska/agent-task-linux-x64` and `@cniska/agent-task` a trusted publisher: GitHub Actions, repository `cniska/agent-task`, workflow `release.yml`. npm checks the calling workflow, agent-task's own `release.yml`, so releases publish with no npm token.
2. In each package's settings on npmjs.com, require two-factor authentication and disallow tokens, so only the trusted publisher can publish.
3. In `cniska/agent-task`'s Actions secrets, add `TAP_DISPATCH_TOKEN`: a fine-grained token on `cniska/homebrew-tap` with Contents read and write.
4. In `cniska/agent-task`'s Settings, under Releases, select Enable release immutability, so each release published afterwards is immutable, as [What a release guarantees](#what-a-release-guarantees) says. The workflow publishes the same way with the setting off.

`agent-ship doctor`, run in the checkout, reports whether each credential `ship.toml` names is present.

## Each release

1. On a clean `main` at origin's commit, run `agent-ship check`, then `agent-ship release`, or `agent-ship release patch|minor|major` to choose the level. It runs `bun run check`, commits `chore: release vX.Y.Z` and tags it.
2. Push `main`, then the tag, as it prints.
3. Run `agent-ship status vX.Y.Z` until every channel is `served`.

The release body is GitHub's generated notes; a published release's title and notes stay editable, immutable or not.

## A bad release

Re-running the workflow on a tag publishes nothing twice, as agent-ship's [stages](https://github.com/cniska/agent-ship/blob/main/docs/releasing.md#stages) say. A tag that published nothing can be deleted and made again once the fix is on `main`. Once a tag has published anything, publish the fix as a new, higher version; a tag is never moved. With release immutability on, GitHub enforces that: a published release's tag can be neither moved nor deleted, and its name cannot be used again even after the release is deleted. A machine that installed the bad release takes the fix through its channel's update.
