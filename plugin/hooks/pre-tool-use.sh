#!/usr/bin/env bash
set -uo pipefail

export AGENT_TASK_NO_UPDATE_CHECK=1

readonly HALTED=1
readonly UNGATED=1
readonly REFUSED=2
readonly ONLY_AGENT_TASK='^[[:blank:]]*agent-task([[:blank:]][^;&|<>$`(){}\\[:cntrl:]]*)?$'

hook_input() {
  local input
  IFS= read -r -d '' input || true
  printf '%s' "$input"
}

command_of() {
  jq -r --argjson tools "$2" 'if (.tool_name as $tool | $tools | index($tool)) and (.tool_input.command | type) == "string" then .tool_input.command else empty end' 2>/dev/null <<<"$1"
}

runs_only_agent_task() {
  local call
  call="$(command_of "$1" '["Bash","PowerShell"]')" || return 1
  [[ -n "$call" && "$call" =~ $ONLY_AGENT_TASK ]]
}

refuse() {
  printf '%s\n%s\n' "$1" "$2" >&2
  exit "$REFUSED"
}

halt_gate() {
  local refusal status
  refusal="$(agent-task halted 2>&1 >/dev/null)"
  status=$?
  [ "$status" -eq "$HALTED" ] || return 0
  agent-task --version >/dev/null 2>&1 || return 0
  runs_only_agent_task "$1" && return 0
  refuse 'cniska-task: all agent work on this machine is halted, so this tool call is refused. Make no further change: state your report and stop. Only the owner lifts the halt. agent-task halted reports:' "$refusal"
}

check_gate() {
  local call refusal status
  call="$(command_of "$1" '["Bash","PowerShell","Monitor"]')" || return 0
  [ -n "$call" ] || return 0
  refusal="$(agent-task gate -- "$call" 2>&1 >/dev/null)"
  status=$?
  [ "$status" -eq "$UNGATED" ] || return 0
  agent-task --version >/dev/null 2>&1 || return 0
  refuse 'cniska-task: this command runs a check outside agent-task check, so this tool call is refused. Checks on this machine run one at a time, and only while it is under its limits, through agent-task check. agent-task gate reports:' "$refusal"
}

main() {
  local input
  input="$(hook_input)"
  halt_gate "$input"
  check_gate "$input"
}

main
exit 0
