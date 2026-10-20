import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { KoraProjectFileFromJson, parseKoraProjectFile } from "./koraProjectFile.ts";

describe("kora.json", () => {
  describe("schema from JSON text", () => {
    const decode = Schema.decodeUnknownSync(KoraProjectFileFromJson);

    it("reads JSONC: comments and trailing commas are fine", () => {
      const file = decode(
        '{\n  /* icon */ "iconPath": "public/icon.png",\n  "scripts": [{ "name": "Test", "command": "pnpm test", },],\n}',
      );
      expect(file.iconPath).toBe("public/icon.png");
      expect(file.scripts).toEqual([{ name: "Test", command: "pnpm test" }]);
    });

    it("throws on text that is not JSON", () => {
      expect(() => decode("{ oops")).toThrow();
    });
  });

  describe("parse helper", () => {
    it("returns the file when valid", () => {
      expect(parseKoraProjectFile('{"defaultThreadEnvMode":"local"}')).toEqual({
        defaultThreadEnvMode: "local",
      });
    });

    it.each(["{ oops", '{"defaultThreadEnvMode":"cloud"}'])("returns null for %s", (text) => {
      expect(parseKoraProjectFile(text)).toBeNull();
    });
  });
});
