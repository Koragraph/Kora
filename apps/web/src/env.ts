/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * The preload script sets window.shellBridge via contextBridge before any web-app
 * code executes, so this is reliable at module load time.
 */
export const isNative = typeof window !== "undefined" && window.shellBridge !== undefined;
