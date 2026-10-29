#!/usr/bin/env bash
set -euo pipefail

die() {
  printf 'build-release: %s\n' "$1" >&2
  exit 1
}

host_target() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) printf 'darwin-arm64\n' ;;
    Linux-x86_64) printf 'linux-x64\n' ;;
    *) die "no release build runs on $(uname -s)-$(uname -m), so none can be smoke-tested here" ;;
  esac
}

main() {
  local target="${TARGET:-}" root host version staging
  [ -n "$target" ] || die "TARGET is not set; set it to the target to build, darwin-arm64 or linux-x64, on a machine of that platform"
  host="$(host_target)"
  [ "$target" = "$host" ] || die "TARGET is $target, but this machine is $host; build each target on a machine of its own platform, so its build is smoke-tested there"
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  (cd "$root" && bun install --frozen-lockfile >/dev/null)
  version="$(cd "$root" && bun -e 'console.log(require("./package.json").version)')"
  staging="$root/dist/$target"
  rm -rf "$staging" "$root/dist/agent-task-$target.tar.gz" "$root/dist/agent-task-$target.sha256"
  mkdir -p "$staging"
  bash "$root/scripts/build-compiled.sh" "$staging/agent-task" "$target" >/dev/null
  bash "$root/scripts/smoke.sh" "$staging/agent-task" "$version"
  tar -czf "$root/dist/agent-task-$target.tar.gz" -C "$staging" agent-task
  rm -rf "$staging"
  (cd "$root/dist" && shasum -a 256 "agent-task-$target.tar.gz" >"agent-task-$target.sha256")
}

main "$@"
