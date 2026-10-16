#!/usr/bin/env bash

note() {
  printf 'cniska-task: %s\n' "$1" >&2
}

prerequisites() {
  if ! jq --version >/dev/null 2>&1; then
    note "jq is not on PATH, so $1"
    return 1
  fi
  if ! realpath / >/dev/null 2>&1; then
    note "realpath is not on PATH, so $1"
    return 1
  fi
}

hook_input() {
  local input
  IFS= read -r -d '' input || true
  printf '%s' "$input"
}

listed_tasks() {
  agent-task list 2>/dev/null
}
