import { usageErrors } from "./coded-error";

export type Command = {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  run(args: readonly string[]): unknown;
};

export const usageError = usageErrors<{
  readonly unknown_command: { readonly name: string; readonly usage: string };
  readonly wrong_arity: { readonly command: string; readonly got: readonly string[]; readonly usage: string };
}>({
  unknown_command: {
    message: ({ name }) => `${name} is not an agent-task command; agent-task with no command lists them`,
    resolve: ({ usage }) => usage,
  },
  wrong_arity: {
    message: ({ command, got }) => `agent-task ${command} takes no argument, and got: ${got.join(" ")}`,
    resolve: ({ usage }) => usage,
  },
});
