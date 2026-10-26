#!/usr/bin/env bash
set -uo pipefail

readonly UNREAD="the session was not told which tasks are running or in review"
readonly HEADING="cniska-task: the running and in-review tasks, as agent-task list --started prints them:"

note() {
  printf 'cniska-task: %s\n' "$1" >&2
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
  agent-task list --started --brief-under "$1" 2>/dev/null
}

reply() {
  jq -n --arg context "$HEADING"$'\n'"$1" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $context}}'
}

main() {
  if ! jq --version >/dev/null 2>&1; then
    note "jq is not on PATH, so $UNREAD"
    return 0
  fi
  local cwd
  if ! cwd="$(hook_input | working_directory)"; then
    note "the hook input did not parse as JSON, so $UNREAD"
    return 0
  fi
  [ -n "$cwd" ] || return 0
  local tasks
  tasks="$(listed_tasks "$cwd")" || return 0
  reply "$tasks"
}

main
exit 0
