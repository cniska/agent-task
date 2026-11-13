# agent-task

Queued and running work lives in `agent-task`, not in a ledger, a notes file or a plan. Queue a task with `agent-task add`, start it with `agent-task start`, hand it back for review with `agent-task review`, and close it with `agent-task done` however its work ended. `agent-task list` shows what is running, in review, ready and waiting, and `agent-task --help` gives every command and flag.

Run every test, check, verify, lint, typecheck or build as `agent-task check '<command>'`, in the background when it may outlast the tool's time limit: it waits until no other check on this machine runs and the machine is under its limits, then runs the command, and any other way of running one is refused.

`agent-task halt "<reason>"` halts all agent work on this machine: while it is raised, edits, shell commands other than `agent-task` and new agents are refused, and only the owner lifts it with `agent-task resume`.

A refusal names the act that resolves it; do it rather than working around the tool.
