#!/usr/bin/env bash
set -uo pipefail

readonly UNREAD="the session was not told which tasks are running or in review"
readonly HALTED=1
readonly UNCHECKED="cniska-task: agent-task could not say whether agent work on this machine is halted, so this session's edits, shell commands and agents go unchecked against a halt."
readonly HALT_HEADING="cniska-task: all agent work on this machine is halted. Make no change: state your report and stop. Only the owner lifts the halt. agent-task halted reports:"
readonly HEADING="cniska-task: the running and in-review tasks, as agent-task list --started prints them:"
readonly OWNER_HEADING="cniska-task: what waits on the owner, by project, as agent-task list --owner prints it:"

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

owner_report() {
  local items
  items="$(agent-task list --owner 2>/dev/null </dev/null)" || return 0
  printf '\n%s\n%s\n' "$OWNER_HEADING" "$items"
}

halt_report() {
  local refusal status
  refusal="$(agent-task halted 2>&1 >/dev/null)"
  status=$?
  case "$status" in
    0) ;;
    "$HALTED") printf '%s\n%s\n\n' "$HALT_HEADING" "$refusal" ;;
    *) printf '%s\n\n' "$UNCHECKED" ;;
  esac
}

main() {
  if ! agent-task --version >/dev/null 2>&1; then
    printf '%s\n' "$UNCHECKED"
    return 0
  fi
  halt_report
  printf '%s\n' "$(<"${BASH_SOURCE[0]%/*}/note.md")"
  owner_report
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
  printf '\n%s\n%s\n' "$HEADING" "$tasks"
}

main
exit 0
