#!/usr/bin/env bash
set -euo pipefail

scratch=""

remove_scratch() {
  [ -z "$scratch" ] || rm -rf "$scratch"
}

main() {
  local executable="${1:?usage: smoke.sh <executable> <version>}"
  local version="${2:?usage: smoke.sh <executable> <version>}"
  test "$("$executable" --version)" = "$version"
  scratch="$(mktemp -d)"
  trap remove_scratch EXIT
  export XDG_DATA_HOME="$scratch/data"
  mkdir "$scratch/repo"
  cd "$scratch/repo"
  git init -q
  printf '# Made-up brief\n' > brief.md
  "$executable" start smoke-task --repo . --brief brief.md | grep -qx 'ok: true'
  "$executable" list | grep -q '^    smoke-task,'
  "$executable" "done" smoke-task | grep -qx 'ok: true'
  "$executable" doctor | grep -qx '  failing: 0'
}

main "$@"
