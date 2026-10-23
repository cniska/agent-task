#!/usr/bin/env bash
set -uo pipefail

readonly UNREAD="the session was not told which tasks are running or in review"
readonly HEADING="cniska-task: the running and in-review tasks, as agent-task list --started prints them:"

note() {
  printf 'cniska-task: %s\n' "$1" >&2
}

prerequisites() {
  if ! jq --version >/dev/null 2>&1; then
    note "jq is not on PATH, so $UNREAD"
    return 1
  fi
  if ! realpath / >/dev/null 2>&1; then
    note "realpath is not on PATH, so $UNREAD"
    return 1
  fi
}

hook_input() {
  local input
  IFS= read -r -d '' input || true
  printf '%s' "$input"
}

working_directory() {
  jq -r '.cwd // ""' 2>/dev/null
}

listed_tasks() {
  agent-task list --started 2>/dev/null
}

context() {
  jq -c --arg dir "$1/" --arg heading "$HEADING" '
    select(any(.result.tasks[]; .brief | startswith($dir)))
    | {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: ([$heading, (.result | tojson)] | join("\n"))
        }
      }' 2>/dev/null
}

main() {
  prerequisites || return 0
  local cwd
  if ! cwd="$(hook_input | working_directory)"; then
    note "the hook input did not parse as JSON, so $UNREAD"
    return 0
  fi
  [ -d "$cwd" ] || return 0
  local real
  real="$(realpath "$cwd" 2>/dev/null)" || return 0
  local tasks
  tasks="$(listed_tasks)" || return 0
  context "$real" <<<"$tasks"
}

main
exit 0
