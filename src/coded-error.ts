export type ErrorKind = "usage" | "refusal" | "fault";

export const EXIT_STATUS: Readonly<Record<ErrorKind, 1 | 2 | 3>> = { refusal: 1, usage: 2, fault: 3 };

export const BUG =
  "stop and hand this error to the owner as a bug in agent-task; no command you run resolves it";

type Coded<Kind extends ErrorKind, Code extends string, Meta extends object> = {
  readonly kind: Kind;
  readonly code: Code;
  readonly message: string;
  readonly meta: Meta;
  readonly resolve: string;
};

export class CodedError<
  Kind extends ErrorKind = ErrorKind,
  Code extends string = string,
  Meta extends object = object,
> extends Error {
  override readonly name = "CodedError";
  readonly kind: Kind;
  readonly code: Code;
  readonly meta: Meta;
  readonly resolve: string;

  constructor({ kind, code, message, meta, resolve }: Coded<Kind, Code, Meta>) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.meta = meta;
    this.resolve = resolve;
  }
}

export type ErrorRecord = Coded<ErrorKind, string, Record<string, unknown>>;

export function recordOf(error: unknown): ErrorRecord {
  if (error instanceof CodedError)
    return {
      kind: error.kind,
      code: error.code,
      message: error.message,
      meta: { ...error.meta },
      resolve: error.resolve,
    };
  return {
    kind: "fault",
    code: "unexpected",
    message: messageOf(error),
    meta: {},
    resolve: BUG,
  };
}

type ErrorTable<Metas extends Record<string, object>> = {
  readonly [Code in keyof Metas]: {
    readonly message: (meta: Metas[Code]) => string;
    readonly resolve: (meta: Metas[Code]) => string;
  };
};

function coder<Kind extends ErrorKind>(kind: Kind) {
  return <Metas extends Record<string, object>>(table: ErrorTable<Metas>) =>
    <Code extends keyof Metas & string>(code: Code, meta: Metas[Code]): CodedError<Kind, Code, Metas[Code]> =>
      new CodedError({
        kind,
        code,
        message: table[code].message(meta),
        meta,
        resolve: table[code].resolve(meta),
      });
}

export const usageErrors = coder("usage");

export const refusals = coder("refusal");

export const faults = coder("fault");

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
