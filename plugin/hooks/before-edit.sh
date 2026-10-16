#!/usr/bin/env bash
set -uo pipefail

source "${BASH_SOURCE[0]%/*}/tasks.sh"

readonly UNJUDGED="the edit was not checked against the running and in-review tasks' briefs"

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
            "\($brief) is the brief of the \($holding | map("\(if .state == "review" then "in-review" else .state end) task \(.name)") | join(" and ")), and a task'"'"'s brief does not change under it while the task runs or is in review. To change it, in this order: "
            + ($holding | map("agent-task stop \(.name)") | join("; "))
            + "; then edit the brief; then "
            + ($holding | map("agent-task start \(.name) --repo \(.repo) --brief \(.brief) [--session <id>]") | join("; "))
            + ", which freezes the edited brief."
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
  tasks="$(listed_tasks)" || return 0
  denial "$real" <<<"$tasks"
}

main
exit 0
