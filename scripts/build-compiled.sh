#!/usr/bin/env bash
set -euo pipefail

main() {
  local outfile="${1:?usage: build-compiled.sh <outfile> [<target>]}"
  local target="${2:-}"
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [ -z "$target" ]; then
    bun build --compile "$root/src/cli.ts" --outfile "$outfile"
  else
    bun build --compile --target "bun-$target" "$root/src/cli.ts" --outfile "$outfile"
  fi
}

main "$@"
