import { describe, expect, test } from "bun:test";
import { userInfo } from "node:os";
import { dataDir, storePath } from "./paths";

describe("the data directory", () => {
  test("is agent-task under an absolute XDG_DATA_HOME", () => {
    expect(dataDir({ home: "/h", dataHome: "/x/data" })).toBe("/x/data/agent-task");
  });

  test("counts an unset or relative XDG_DATA_HOME as $HOME/.local/share", () => {
    expect(dataDir({ home: "/h", dataHome: null })).toBe("/h/.local/share/agent-task");
    expect(dataDir({ home: "/h", dataHome: "data" })).toBe("/h/.local/share/agent-task");
  });

  test("counts an unset HOME as the account's home directory", () => {
    expect(dataDir({ home: null, dataHome: null })).toBe(`${userInfo().homedir}/.local/share/agent-task`);
  });

  test("holds the store as tasks.db", () => {
    expect(storePath({ home: "/h", dataHome: "/x" })).toBe("/x/agent-task/tasks.db");
  });
});
