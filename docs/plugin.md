# Claude Code Plugin

The `cniska-task` plugin, in `plugin/` and the `cniska` marketplace, tells every session where queued and running work lives and puts the running and in-review tasks in its context, and reads the store only through the CLI.

## What it does

Whenever a session starts, resumes, clears or compacts, it adds a short note, `plugin/hooks/note.md`: queued and running work lives in agent-task, not in a ledger, a notes file or a plan, and `add`, `start`, `review` and `done` queue, start, hand back and close a task.

When the working directory holds the brief of a running or in-review task, it adds the running and in-review tasks after the note as `list --started` prints them, `briefChanged` included, so the session sees a task whose brief no longer has the `briefSha` recorded when it started.

The hook asks agent-task with `list --started --brief-under` the session's directory, which runs no queued task's check, and puts what it prints in the context as it is, under a heading. It prints nothing when `agent-task` is not on `PATH`, and the note alone when that command is refused, `no_brief_under` included; it never exits with an error. Without `jq`, which reads the session's directory from the hook's input, it prints the note alone and leaves a line on stderr.

## Install

The plugin brings neither Bun nor the CLI. Install the CLI first, as the [README](../README.md#install) says; the plugin does nothing until `agent-task` is on the `PATH` Claude Code starts with. Its hook also needs `jq`.

The hook sees the `PATH` Claude Code started with, which can differ from a shell's, for example when the desktop app is opened from the Dock, or when the line the curl install adds to a shell file does not reach it. When the hook prints nothing, or prints its note but no running task from a directory that holds one's brief, run `agent-task doctor` under that `PATH`.
