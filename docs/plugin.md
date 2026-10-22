# Claude Code Plugin

The `cniska-task` plugin, in `plugin/` and the `cniska` marketplace, keeps a running or in-review task's brief from changing under the task, and reads the store only through the CLI.

## What it does

- Before each `Edit`, `Write` or `MultiEdit`, it denies an edit to a file that is the brief of a running or in-review task. The denial names the task, its state and what to do, in order: `agent-task stop <name>`, then the edit, then `agent-task start <name> --repo <repo> --brief <file> [--session <id>]`, which freezes the edited brief. A brief that is gone is still matched by its path. Every other edit passes without a word.
- When a session starts, resumes, clears or compacts in a working directory that holds the brief of a running or in-review task, it puts the running and in-review tasks in the session's context as `list --started` prints them, `briefChanged` included. Elsewhere it prints nothing.

A hook reads the tasks with `list --started`, which runs no queued task's check. It prints nothing and denies nothing when `agent-task` is not on `PATH` or `list --started` is refused, and never exits with an error. Without `jq` or `realpath` it leaves a note on stderr.

## Install

The plugin brings neither Bun nor the CLI. Install the CLI first, as the [README](../README.md#install) says; the plugin does nothing until `agent-task` is on the `PATH` Claude Code starts with. Its hooks also need `jq` and `realpath`.

The hooks see the `PATH` Claude Code started with, which can differ from a shell's, for example when the desktop app is opened from the Dock, or when the line the curl install adds to a shell file does not reach it. When a hook is silent, run `agent-task doctor` under that `PATH`.
