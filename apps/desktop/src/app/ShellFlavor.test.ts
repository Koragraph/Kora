import { describe, expect, it } from "vite-plus/test";

import { flavorEnv, parseFlavorEnv } from "./ShellFlavor.ts";

describe("ShellFlavor", () => {
  const file = parseFlavorEnv(
    'KORA_APP_FLAVOR=dev\nKORA_APP_NAME="Kora Dev"\nKORA_HOME_NAME=.kora-dev\nKORA_PORT=8790\nKORA_CLI_NAME=kora-dev\n',
  );

  // POSIX path fixtures (/Users/me).
  // oxlint-disable-next-line kora/no-global-process-runtime -- a test skip condition, decided before any runtime exists
  it.skipIf(process.platform === "win32")(
    "a Kora Dev bundle gets its own home, port, graph store and CLI name",
    () => {
      expect(flavorEnv(file, "/Users/me")).toEqual({
        KORA_APP_FLAVOR: "dev",
        KORA_APP_NAME: "Kora Dev",
        KORA_HOME: "/Users/me/.kora-dev",
        KORA_SOCKET_PATH: "/Users/me/.kora-dev/kora.sock",
        KORA_PORT: "8790",
        KORA_UI_PORT: "8790",
        KORA_CLI_NAME: "kora-dev",
        KORAGRAPH_HOME: "/Users/me/.kora-dev/koragraph",
        KORAGRAPH_DB: "/Users/me/.kora-dev/koragraph/graph.db",
        KORAGRAPH_PRACTICE_DB: "/Users/me/.kora-dev/koragraph/practice.db",
      });
    },
  );

  it("no flavor = nothing changes", () => {
    expect(flavorEnv(parseFlavorEnv(""), "/Users/me")).toEqual({});
  });
});
