import * as NativeProtocol from "../native/NativeProtocol.ts";

/**
 * Everything that must be settled before Electron emits `ready`. On macOS that is only the custom URL schemes'
 * privileges (they are ignored once the app is ready), so the layer is just that registration. main.ts builds it
 * as the outermost layer so it runs first.
 */
export const layer = NativeProtocol.layerSchemePrivileges;
