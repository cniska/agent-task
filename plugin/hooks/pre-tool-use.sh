#!/usr/bin/env bash
set -uo pipefail

readonly HALTED=1
readonly REFUSED=2
readonly ONLY_AGENT_TASK='^[[:blank:]]*agent-task([[:blank:]][^;&|<>$`(){}\\[:cntrl:]]*)?$'

hook_input() {
  local input
  IFS= read -r -d '' input || true
  printf '%s' "$input"
}

runs_only_agent_task() {
  local call
  call="$(jq -r 'if (.tool_name == "Bash" or .tool_name == "PowerShell") and (.tool_input.command | type) == "string" then .tool_input.command else empty end' 2>/dev/null <<<"$1")" || return 1
  [[ -n "$call" && "$call" =~ $ONLY_AGENT_TASK ]]
}

refuse() {
  printf 'cniska-task: all agent work on this machine is halted, so this tool call is refused. Make no further change: state your report and stop. Only the owner lifts the halt. agent-task halted reports:\n%s\n' "$1" >&2
  exit "$REFUSED"
}

main() {
  local input refusal status
  input="$(hook_input)"
  refusal="$(agent-task halted 2>&1 >/dev/null)"
  status=$?
  [ "$status" -eq "$HALTED" ] || return 0
  agent-task --version >/dev/null 2>&1 || return 0
  runs_only_agent_task "$input" && return 0
  refuse "$refusal"
}

main
exit 0
