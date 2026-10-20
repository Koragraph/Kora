import { definePlugin } from "@oxlint/plugins";

import noNativeTitleTooltip from "./rules/no-native-title-tooltip.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noGlobalProcessRuntime from "./rules/no-global-process-runtime.ts";
import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noNegativePidKill from "./rules/no-negative-pid-kill.ts";
import noPosixOnlyPaths from "./rules/no-posix-only-paths.ts";
import noRawCliSpawn from "./rules/no-raw-cli-spawn.ts";
import noSlashSplitPath from "./rules/no-slash-split-path.ts";

export default definePlugin({
  meta: {
    name: "kora",
  },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-global-process-runtime": noGlobalProcessRuntime,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-native-title-tooltip": noNativeTitleTooltip,
    "no-negative-pid-kill": noNegativePidKill,
    "no-posix-only-paths": noPosixOnlyPaths,
    "no-raw-cli-spawn": noRawCliSpawn,
    "no-slash-split-path": noSlashSplitPath,
  },
});
