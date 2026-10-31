export const USAGE = {
  add: "agent-task add <name> --repo <path> --goal <text> [--project <id>] [--plan <file>] [--priority urgent|high|medium|low] [--after <name>]... [--waits <text>] [--until <command>]",
  start: "agent-task start <name> --repo <path> --brief <file> [--project <id>] [--session <id>]",
  wait: "agent-task wait <name> [--after <name>]... [--waits <text>] [--until <command>]",
  map: "agent-task map <name> --project <id>",
  review: "agent-task review <name>",
  list: "agent-task list [--started [--brief-under <dir>]] [--project <id>] [--full]",
  stop: "agent-task stop <name>",
  done: "agent-task done <name>",
} as const;

export const PROJECT_USAGE = {
  add: "agent-task project add <id> --name <text> --repo <path> --dir <dir>",
  list: "agent-task project list",
  remove: "agent-task project remove <id>",
} as const;

export function actFor(usage: string, name: string): string {
  return usage.replace("<name>", name);
}

export function projectActFor(usage: string, id: string): string {
  return usage.replace("<id>", id);
}
