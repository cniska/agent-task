import { describe, expect, test } from "bun:test";
import { userInfo } from "node:os";
import { curlInstallPath, dataDir, storePath, updateCheckPath } from "./paths";

const UNSET = { home: null, dataHome: null, stateHome: null };

describe("the data directory", () => {
  test("is agent-task under an absolute XDG_DATA_HOME", () => {
    expect(dataDir({ ...UNSET, home: "/h", dataHome: "/x/data" })).toBe("/x/data/agent-task");
  });

  test("counts an unset or relative XDG_DATA_HOME as $HOME/.local/share", () => {
    expect(dataDir({ ...UNSET, home: "/h" })).toBe("/h/.local/share/agent-task");
    expect(dataDir({ ...UNSET, home: "/h", dataHome: "data" })).toBe("/h/.local/share/agent-task");
  });

  test("counts an unset HOME as the account's home directory", () => {
    expect(dataDir(UNSET)).toBe(`${userInfo().homedir}/.local/share/agent-task`);
  });

  test("holds the store as tasks.db", () => {
    expect(storePath({ ...UNSET, home: "/h", dataHome: "/x" })).toBe("/x/agent-task/tasks.db");
  });
});

describe("the update check's state", () => {
  test("is update-check.json under agent-task in an absolute XDG_STATE_HOME", () => {
    expect(updateCheckPath({ ...UNSET, home: "/h", stateHome: "/x/state" })).toBe(
      "/x/state/agent-task/update-check.json",
    );
  });

  test("counts an unset or relative XDG_STATE_HOME as $HOME/.local/state", () => {
    expect(updateCheckPath({ ...UNSET, home: "/h" })).toBe("/h/.local/state/agent-task/update-check.json");
    expect(updateCheckPath({ ...UNSET, home: "/h", stateHome: "state" })).toBe(
      "/h/.local/state/agent-task/update-check.json",
    );
  });
});

describe("the curl install", () => {
  test("is agent-task in $HOME/.local/bin", () => {
    expect(curlInstallPath({ ...UNSET, home: "/h" })).toBe("/h/.local/bin/agent-task");
  });
});
