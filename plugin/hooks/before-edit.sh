#!/usr/bin/env bash
set -uo pipefail

source "${BASH_SOURCE[0]%/*}/tasks.sh"

readonly UNJUDGED="the edit was not checked against the running tasks' briefs"

edited_file() {
  jq -r '
    (.tool_input.file_path // "") as $file
    | (.cwd // "") as $cwd
    | if ($file | startswith("/")) then $file
      elif $file != "" and ($cwd | startswith("/")) then "\($cwd)/\($file)"
      else "" end' 2>/dev/null
}

denial() {
  jq -c --arg brief "$1" '
    [.result.tasks[] | select(.brief == $brief)] as $holding
    | select(($holding | length) > 0)
    | {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: (
            "\($brief) is the brief of the running task \($holding | map(.name) | join(" and ")), and a running task'"'"'s brief does not change under it. To change it, in this order: "
            + ($holding | map("agent-task drop \(.name) --reason <why the work is given up>") | join("; "))
            + "; then edit the brief; then "
            + ($holding | map("agent-task start <new-name> --repo \(.repo) --brief \(.brief)") | join("; "))
            + ", under a name the store has never held, since a dropped name stays taken."
          )
        }
      }' 2>/dev/null
}

real_path() {
  local prefix="$1" rest="" resolved
  while ! resolved="$(realpath "$prefix" 2>/dev/null)"; do
    rest="/${prefix##*/}$rest"
    prefix="${prefix%/*}"
    [ -n "$prefix" ] || prefix=/
  done
  printf '%s%s\n' "${resolved%/}" "$rest"
}

main() {
  prerequisites "$UNJUDGED" || return 0
  local file
  if ! file="$(hook_input | edited_file)"; then
    note "the hook input did not parse as JSON, so $UNJUDGED"
    return 0
  fi
  [ -n "$file" ] || return 0
  local real
  real="$(real_path "$file")"
  local tasks
  tasks="$(running_tasks)" || return 0
  denial "$real" <<<"$tasks"
}

main
exit 0
