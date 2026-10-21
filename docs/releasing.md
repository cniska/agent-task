# Releasing

A `v*` tag on `main` runs `.github/workflows/release.yml`. It compiles darwin-arm64 and linux-x64 with `scripts/build-compiled.sh`, smoke-tests each build with `scripts/smoke.sh` (it prints its version, runs `start`, `list` and `done` on a made-up brief in a scratch repository and passes `doctor` there), attests the build provenance of both tarballs and `install.sh`, creates the tag's GitHub release as a draft, attaches each build's tarball and sha256, `install.sh` and `SHA256SUMS.txt` to it and only then publishes it, publishes the three npm packages with provenance, and dispatches `cniska/homebrew-tap` to repin `Formula/agent-task.rb`. Once the registry serves all three published packages, a job on each platform installs the version with `npm install -g` and with `bun add -g`, and runs `scripts/smoke.sh` on each install's launcher with no `node` or `bun` on `PATH`; either install failing fails the run, and a patch release carries the fix. Run by `workflow_dispatch` instead, it builds, smoke-tests and packs everything and publishes nothing, an attestation included: the release files and `npm pack --dry-run` are its output.

A release never updates itself. Each channel updates the way it installed: `brew upgrade agent-task`, `npm update -g @cniska/agent-task`, `bun update -g @cniska/agent-task`, or the curl line run again.

## What a release guarantees

- **Built by `release.yml` at the tag.** Each tarball and `install.sh` carries a build provenance attestation, signed through Sigstore by the tag's run. With [`gh`](https://cli.github.com), `gh attestation verify <file> -R cniska/agent-task --signer-workflow cniska/agent-task/.github/workflows/release.yml --source-ref refs/tags/<tag>` proves the file was built by `release.yml` from the tagged commit; `-R` alone proves only that some workflow in the repository built it. The `.sha256` files and `SHA256SUMS.txt` are not attested.
- **Unchanged since it was published.** With release immutability on, GitHub locks a published release's files and its tag and records a release attestation of its tag, commit and files. `gh release verify <tag>` proves the release is immutable, and `gh release verify-asset <tag> <file>` proves a local file is the one the release published. Both hold only for a release published after the setting was turned on; GitHub never makes an earlier release immutable. The `homebrew` job dispatches the repin only once the release is published, so the formula pins files that, with the setting on, cannot change.
- **Matches its checksum.** `install.sh` checks each tarball against its `.sha256` from the same release, which catches a broken download, not a changed release, and runs neither check above, since a curl install cannot assume `gh`.

## The owner's setup, once

1. Publish each npm package once by hand, so trusted publishing can be set on it: `@cniska/agent-task-darwin-arm64`, `@cniska/agent-task-linux-x64`, then `@cniska/agent-task`. Build them from the first release's files with `bun scripts/build-npm.ts <release files> dist/npm`, then `npm publish ./dist/npm/<package> --access public` for each.
2. On npmjs.com, add a trusted publisher to each of the three packages: GitHub Actions, repository `cniska/agent-task`, workflow `release.yml`. Later releases publish with no npm token.
3. In each package's settings on npmjs.com, require two-factor authentication and disallow tokens, so only the trusted publisher can publish.
4. In `cniska/agent-task`'s Actions secrets, add `TAP_DISPATCH_TOKEN`: a fine-grained token on `cniska/homebrew-tap` with Contents read and write, which the `homebrew` job uses to dispatch the repin.
5. In `cniska/agent-task`'s Settings, under Releases, select Enable release immutability, so each release published afterwards is immutable, as [What a release guarantees](#what-a-release-guarantees) says. The workflow publishes the same way with the setting off.

## Each later release

1. On a clean `main`, run `scripts/release.sh patch|minor|major`. It bumps `package.json`, refuses a version the release check rejects, runs `bun run check`, commits `chore: release vX.Y.Z` and tags it.
2. Push `main`, then the tag, as it prints.
3. The release body is GitHub's generated notes, made when the draft is created; a published release's title and notes stay editable, immutable or not.

The release check, `scripts/release-check.ts`, runs on every tag in the workflow too: the tag must be `v` and the `package.json` version, and newer than the previous tag.

## A bad release

A tag whose build failed published nothing, since every publish job waits on the builds. A run that failed in the `release` job can leave a draft release for the tag, which no one sees but the repository's writers. Re-running the job is safe: it deletes a draft left for the tag before it creates its own, and over a tag already published it skips the attestation, the draft and the publish, so re-running every job still reaches npm and Homebrew.

To tag the same version again after a run that published no release, delete any draft for the tag (`gh release delete vX.Y.Z`), then the tag on origin and locally, then, once the fix is on `main`, tag `main` again (`git tag -m vX.Y.Z vX.Y.Z`) and push that tag. Once a tag has published anything, publish the fix as a new, higher version; a tag is never moved. With release immutability on, GitHub enforces that: a published release's tag can be neither moved nor deleted, and its name cannot be used again even after the release is deleted. A machine that installed the bad release takes the fix through its channel's update.
