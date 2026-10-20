// Flip Electron's build-time fuses on the staged app binary (called by scripts/package-app.sh before signing:
// flipping changes the binary, so any earlier signature would break).
//
// Off: Electron-as-node, NODE_OPTIONS, --inspect and file:// extra privileges. With these on, any local process could
// run code as the signed Kora (and inherit its entitlements). Nothing in Kora uses them: the daemon runs on the bundled
// node, the launchers strip ELECTRON_RUN_AS_NODE, and the web client is served over kora://.
//
// Cookie encryption stays OFF for now: it keys Electron's cookie store to a Keychain item, and an ad-hoc signed build
// (every Kora Dev rebuild) then raises a Keychain prompt at launch. Blob browsers are a separate Chrome with their own
// profile, so it would only cover the in-app browser pane. Turn it on together with Developer ID-only builds.
//
// Usage: node flip-fuses.mjs <path to Contents/MacOS/Kora>
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";

const binary = process.argv[2];
if (!binary) {
  console.error("usage: flip-fuses.mjs <electron binary>");
  process.exit(2);
}

await flipFuses(binary, {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
});
