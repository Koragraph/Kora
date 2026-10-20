import { assert, describe, it } from "@effect/vitest";

import { legacyStateFilePath } from "./legacyStateFiles.ts";

describe("legacyStateFiles", () => {
  it("maps renamed state files to their pre-rename names and leaves others alone", () => {
    assert.equal(
      legacyStateFilePath("/u/.kora/userdata/shell-prefs.json"),
      "/u/.kora/userdata/desktop-settings.json",
    );
    assert.equal(
      legacyStateFilePath("/u/.kora/userdata/client-prefs.json"),
      "/u/.kora/userdata/client-settings.json",
    );
    assert.equal(
      legacyStateFilePath("C:\\kora\\client-prefs.json"),
      "C:\\kora\\client-settings.json",
    );
    assert.equal(legacyStateFilePath("client-prefs.json"), "client-settings.json");
    assert.isUndefined(legacyStateFilePath("/u/.kora/userdata/settings.json"));
  });
});
