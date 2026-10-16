#!/usr/bin/env bash
set -uo pipefail

source "${BASH_SOURCE[0]%/*}/tasks.sh"

readonly UNREAD="the session was not told which tasks are running or in review"
readonly HEADING="cniska-task: the running and in-review tasks, as agent-task list prints them:"
readonly CLOSING="A running or in-review task's brief does not change under it: the plugin denies an edit to one, naming agent-task stop, the edit and agent-task start again."

working_directory() {
  jq -r '.cwd // ""' 2>/dev/null
}

context() {
  jq -c --arg dir "$1/" --arg heading "$HEADING" --arg closing "$CLOSING" '
    select(any(.result.tasks[]; .brief | startswith($dir)))
    | {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: ([$heading, (.result | tojson), $closing] | join("\n"))
        }
      }' 2>/dev/null
}

main() {
  prerequisites "$UNREAD" || return 0
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
