#!/usr/bin/env bash
set -euo pipefail

TARGETS=(darwin-arm64 linux-x64)

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

build_target() {
  local root="$1" target="$2" host="$3" version="$4" staging
  staging="$root/dist/$target"
  mkdir -p "$staging"
  bash "$root/scripts/build-compiled.sh" "$staging/agent-task" "$target" >/dev/null
  if [ "$target" = "$host" ]; then
    bash "$root/scripts/smoke.sh" "$staging/agent-task" "$version"
  fi
  tar -czf "$root/dist/agent-task-$target.tar.gz" -C "$staging" agent-task
  rm -rf "$staging"
  (cd "$root/dist" && shasum -a 256 "agent-task-$target.tar.gz" >"agent-task-$target.sha256")
}

main() {
  local root host version target
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  host="$(host_target)"
  (cd "$root" && bun install --frozen-lockfile >/dev/null)
  version="$(cd "$root" && bun -e 'console.log(require("./package.json").version)')"
  rm -rf "$root/dist"
  mkdir -p "$root/dist"
  for target in "${TARGETS[@]}"; do
    build_target "$root" "$target" "$host" "$version"
  done
  cp "$root/scripts/install.sh" "$root/dist/install.sh"
  (cd "$root/dist" && shasum -a 256 -- agent-task-*.tar.gz install.sh >SHA256SUMS.txt)
}

main "$@"
