import { afterEach, expect, test } from "bun:test";
import { userInfo } from "node:os";
import { removeScratch, world } from "./harness";

afterEach(removeScratch);

test("AC-21 the test environment's home and XDG directories are scratch directories", () => {
  const account = userInfo().homedir;
  const scratch = [
    process.env.HOME,
    process.env.XDG_DATA_HOME,
    process.env.XDG_CONFIG_HOME,
    process.env.XDG_STATE_HOME,
  ];
  for (const dir of scratch) {
    expect(dir).toBeString();
    expect(dir?.startsWith(account)).toBe(false);
  }
  const w = world();
  expect(w.env.HOME?.startsWith(account)).toBe(false);
  expect(w.env.XDG_DATA_HOME?.startsWith(w.root)).toBe(true);
});
