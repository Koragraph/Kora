// @effect-diagnostics nodeBuiltinImport:off -- Build-time plugin run by Vite/Rolldown, outside any Effect runtime.
/**
 * Build-time plugin for the picker preload bundle: resolves
 * `virtual:kora-pick-main-world` to the main-world half of the picker
 * (`src/web/PickMainWorld.ts` + react-grab) bundled as one self-contained,
 * minified IIFE, exported as a string. `PickPreload.ts` evaluates that string in
 * the page's main world (see `src/web/PickMainWorldProtocol.ts` for why).
 *
 * A missing plugin is a hard build error (the virtual id does not resolve), never
 * a silently empty script.
 */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { Rolldown } from "vite-plus/pack";

import { PICK_MAIN_WORLD_GLOBAL_NAME } from "../src/web/PickMainWorldProtocol.ts";

const PICK_MAIN_WORLD_MODULE_ID = "virtual:kora-pick-main-world";
const RESOLVED_MODULE_ID = `\0${PICK_MAIN_WORLD_MODULE_ID}`;

const defaultEntry = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
  "src",
  "web",
  "PickMainWorld.ts",
);

export async function bundlePickMainWorld(
  entry: string = defaultEntry,
): Promise<{ readonly code: string; readonly moduleIds: ReadonlyArray<string> }> {
  const bundle = await Rolldown.rolldown({ input: entry, platform: "browser" });
  try {
    const { output } = await bundle.generate({
      format: "iife",
      name: PICK_MAIN_WORLD_GLOBAL_NAME,
      minify: true,
      sourcemap: false,
    });
    const chunk = output.find((item) => item.type === "chunk" && item.isEntry);
    if (!chunk || chunk.type !== "chunk") throw new Error("Picker main-world bundle has no entry");
    if (!chunk.code.includes(PICK_MAIN_WORLD_GLOBAL_NAME)) {
      throw new Error("Picker main-world bundle does not define its global");
    }
    return { code: chunk.code, moduleIds: chunk.moduleIds };
  } finally {
    await bundle.close();
  }
}

export function pickMainWorldPlugin(entry: string = defaultEntry): Rolldown.Plugin {
  return {
    name: "kora-pick-main-world",
    resolveId(id) {
      return id === PICK_MAIN_WORLD_MODULE_ID ? RESOLVED_MODULE_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_MODULE_ID) return null;
      const { code, moduleIds } = await bundlePickMainWorld(entry);
      for (const moduleId of moduleIds) {
        if (!moduleId.startsWith("\0")) this.addWatchFile(moduleId);
      }
      return `export default ${JSON.stringify(code)};`;
    },
  };
}
