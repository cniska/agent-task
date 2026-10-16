import { usageErrors } from "./coded-error";
import type { ProcessEnv } from "./git";
import type { Env } from "./paths";

export type Runtime = {
  readonly cwd: string;
  readonly env: Env;
  readonly processEnv: ProcessEnv;
  readonly busyWaitMs: number;
  readonly now: () => Date;
};

export type Command = {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  run(args: readonly string[], runtime: Runtime): unknown;
};

export const usageError = usageErrors<{
  readonly unknown_command: { readonly name: string; readonly usage: string };
  readonly wrong_arity: { readonly command: string; readonly got: readonly string[]; readonly usage: string };
  readonly bad_arguments: { readonly command: string; readonly detail: string; readonly usage: string };
}>({
  unknown_command: {
    message: ({ name }) => `${name} is not an agent-task command; agent-task with no command lists them`,
    resolve: ({ usage }) => usage,
  },
  wrong_arity: {
    message: ({ command, got }) => `agent-task ${command} takes no argument, and got: ${got.join(" ")}`,
    resolve: ({ usage }) => usage,
  },
  bad_arguments: {
    message: ({ command, detail }) => `agent-task ${command}: ${detail}`,
    resolve: ({ usage }) => usage,
  },
});
