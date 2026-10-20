// Test support: a ShellContext for a packaged macOS app with its home (and KORA_HOME) in `home`.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";

import * as ShellConfig from "../app/ShellConfig.ts";
import * as ShellContext from "../app/ShellContext.ts";

export function packagedContextLayer(
  home: string,
  facts: Partial<ShellContext.MakeShellContextInput> = {},
  env: Record<string, string | undefined> = {},
) {
  return ShellContext.layer({
    homeDirectory: home,
    appVersion: "0.1.14",
    isPackaged: true,
    appPath: "/Applications/Kora.app/Contents/Resources/app.asar",
    resourcesPath: "/Applications/Kora.app/Contents/Resources",
    dirname: "/Applications/Kora.app/Contents/Resources/app.asar/dist-electron",
    platform: "darwin",
    processArch: "arm64",
    runningUnderArm64Translation: false,
    ...facts,
  }).pipe(
    Layer.provide(
      Layer.merge(ShellConfig.layerTest({ KORA_HOME: home, ...env }), NodeServices.layer),
    ),
  );
}
