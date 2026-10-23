# Claude Code Plugin

The `cniska-task` plugin, in `plugin/` and the `cniska` marketplace, puts the running and in-review tasks in a session's context, and reads the store only through the CLI.

## What it does

When a session starts, resumes, clears or compacts in a working directory that holds the brief of a running or in-review task, it puts the running and in-review tasks in the session's context as `list --started` prints them, `briefChanged` included, so the session sees a task whose brief no longer has the `briefSha` recorded when it started. Elsewhere it prints nothing.

The hook reads the tasks with `list --started`, which runs no queued task's check. It prints nothing when `agent-task` is not on `PATH` or `list --started` is refused, and never exits with an error. Without `jq` or `realpath` it leaves a note on stderr.

## Install

The plugin brings neither Bun nor the CLI. Install the CLI first, as the [README](../README.md#install) says; the plugin does nothing until `agent-task` is on the `PATH` Claude Code starts with. Its hook also needs `jq` and `realpath`.

The hook sees the `PATH` Claude Code started with, which can differ from a shell's, for example when the desktop app is opened from the Dock, or when the line the curl install adds to a shell file does not reach it. When the hook is silent, run `agent-task doctor` under that `PATH`.
