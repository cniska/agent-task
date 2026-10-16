import { describe, expect, test } from "bun:test";
import { BUG, CodedError, EXIT_STATUS, faults, recordOf, refusals, usageErrors } from "./coded-error";

const refuse = refusals<{ readonly taken: { readonly name: string } }>({
  taken: {
    message: ({ name }) => `${name} is taken`,
    resolve: ({ name }) => `pick a name other than ${name}`,
  },
});

describe("coded errors", () => {
  test("a coder builds its kind's error from the table, with the facts as meta", () => {
    const error = refuse("taken", { name: "a" });
    expect(error).toBeInstanceOf(CodedError);
    expect(recordOf(error)).toEqual({
      kind: "refusal",
      code: "taken",
      message: "a is taken",
      meta: { name: "a" },
      resolve: "pick a name other than a",
    });
  });

  test("each kind exits with its own status", () => {
    const usage = usageErrors<{ readonly u: object }>({ u: { message: () => "u", resolve: () => "u" } });
    const fault = faults<{ readonly f: object }>({ f: { message: () => "f", resolve: () => BUG } });
    expect(
      [usage("u", {}), refuse("taken", { name: "a" }), fault("f", {})].map((e) => EXIT_STATUS[e.kind]),
    ).toEqual([2, 1, 3]);
  });

  test("an error that is not coded is recorded as an unexpected fault naming the bug", () => {
    expect(recordOf(new TypeError("boom"))).toEqual({
      kind: "fault",
      code: "unexpected",
      message: "boom",
      meta: {},
      resolve: BUG,
    });
    expect(recordOf("text")).toMatchObject({ kind: "fault", message: "text" });
  });
});
