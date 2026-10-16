import { expect, test } from "bun:test";
import { invariant, unreachable } from "./assert";

test("unreachable faults with its code, naming the value that reached it", () => {
  expect(() => Reflect.apply(unreachable, undefined, ["stray"])).toThrow(
    expect.objectContaining({ code: "unreachable", kind: "fault", message: 'unreachable: "stray"' }),
  );
});

test("invariant passes a held condition and faults on a broken one with its code, naming it", () => {
  expect(() => invariant(true, "held")).not.toThrow();
  expect(() => invariant(null, "the row exists")).toThrow(
    expect.objectContaining({
      code: "invariant_failed",
      kind: "fault",
      message: "invariant failed: the row exists",
    }),
  );
});
