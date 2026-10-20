import type { ShellWebScreencastFrame } from "@kora/contracts";
import { contextBridge, ipcRenderer } from "electron";

import { IPC_WEB_POPOUT_FRAME } from "./ipc/channelNames.ts";

contextBridge.exposeInMainWorld("webPopout", {
  onFrame: (listener: (frame: ShellWebScreencastFrame) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, frame: unknown) => {
      if (typeof frame !== "object" || frame === null) return;
      listener(frame as ShellWebScreencastFrame);
    };
    ipcRenderer.on(IPC_WEB_POPOUT_FRAME, wrappedListener);
    return () => ipcRenderer.removeListener(IPC_WEB_POPOUT_FRAME, wrappedListener);
  },
});
