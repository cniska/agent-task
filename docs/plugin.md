# Claude Code Plugin

The `cniska-task` plugin, in `plugin/` and the `cniska` marketplace, tells every session where queued and running work lives, puts the running and in-review tasks in its context, and enforces a halt. It reads the store only through the CLI.

## What it does

Whenever a session starts, resumes, clears or compacts, it adds a short note, `plugin/hooks/note.md`: queued and running work lives in agent-task, not in a ledger, a notes file or a plan, and `add`, `start`, `review` and `done` queue, start, hand back and close a task.

When the working directory holds the brief of a running or in-review task, it adds the running and in-review tasks after the note as `list --started` prints them, `briefChanged` included, so the session sees a task whose brief no longer has the `briefSha` recorded when it started.

The session hook asks agent-task with `list --started --brief-under` the session's directory, which runs no queued task's check, and puts what it prints in the context as it is, under a heading. It prints the note alone when that command is refused, `no_brief_under` included; it never exits with an error. Without `jq`, which reads the session's directory from the hook's input, it prints the note alone and leaves a line on stderr.

## The halt

While a halt is raised, as `agent-task halted` reports it, the plugin stops the session's work:

- **Session start**: a heading saying all agent work is halted, then the refusal `halted` prints with its reason, come before the note.
- **Tool calls**: a `PreToolUse` hook refuses `Edit`, `Write`, `NotebookEdit`, `Bash`, `PowerShell`, `Monitor`, `Agent`, `Workflow` and `EnterWorktree`, naming the reason. Every other tool works, so a halted agent can still read and report.
- **agent-task commands**: a `Bash` or `PowerShell` command that runs only `agent-task`, with no shell operator, expansion or control character, goes through, so `halt` and `resume` still work.
- **Unreadable input**: while halted, a call whose input the hook cannot read, without `jq` or not JSON, is refused.

The hooks decide on `halted`'s exit status alone. When `agent-task` is missing, too old to know `halted`, or fails `--version`, calls go through and session start says the halt could not be checked.

## Install

The plugin brings neither Bun nor the CLI. Install the CLI first, as the [README](../README.md#install) says; the plugin checks nothing until `agent-task` is on the `PATH` Claude Code starts with. Its hooks also need `jq`.

The hooks see the `PATH` Claude Code started with, which can differ from a shell's, for example when the desktop app is opened from the Dock, or when the line the curl install adds to a shell file does not reach it. When session start says the halt could not be checked, or prints its note but no running task from a directory that holds one's brief, run `agent-task doctor` under that `PATH`.
