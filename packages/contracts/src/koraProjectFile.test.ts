import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { KoraProjectFile } from "./koraProjectFile.ts";

const read = Schema.decodeUnknownSync(KoraProjectFile);

describe("kora.json schema", () => {
  it("reads icon, scripts with every option, and bare scripts", () => {
    const file = read({
      $schema: "https://kora.dev/schema/kora.json",
      iconPath: "public/mark.png",
      scripts: [
        { name: "Bootstrap", command: "make deps", async: false, runOnWorktreeCreate: true },
        { name: "Lint", command: "make lint" },
        {
          name: "Serve",
          command: "make serve",
          icon: "play",
          runOnWorktreeCreate: false,
          previewUrl: "http://127.0.0.1:8000",
          autoOpenPreview: true,
        },
      ],
    });
    expect(file.iconPath).toBe("public/mark.png");
    expect(file.scripts?.length).toBe(3);
    expect(file.scripts?.[0]?.async).toBe(false);
    expect(file.scripts?.[1]).toEqual({ name: "Lint", command: "make lint" });
  });

  it("accepts an empty file and drops unknown keys", () => {
    expect([read({}), read({ addedInTheFuture: 1 })]).toEqual([{}, {}]);
  });

  it("trims the icon path and script strings", () => {
    const file = read({
      iconPath: "\tpublic/mark.png ",
      scripts: [{ command: " make lint ", name: " Lint " }],
    });
    expect(file).toEqual({
      iconPath: "public/mark.png",
      scripts: [{ name: "Lint", command: "make lint" }],
    });
  });

  it.each([
    ["a script with no command", { scripts: [{ name: "Lint" }] }],
    [
      "an icon it does not know",
      { scripts: [{ name: "Lint", command: "make lint", icon: "unicorn" }] },
    ],
    ["an unknown env mode", { defaultThreadEnvMode: "cloud" }],
  ])("refuses %s", (_label, input) => {
    expect(() => read(input)).toThrow();
  });

  it.each(["local", "worktree"])("reads defaultThreadEnvMode %s", (mode) => {
    expect(read({ defaultThreadEnvMode: mode }).defaultThreadEnvMode).toBe(mode);
  });
});
