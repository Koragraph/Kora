import { projectShellState } from "./useWebBridge";
import { describe, expect, it } from "vite-plus/test";
import type { ShellWebTabState } from "@kora/contracts";

const favicon = {
  capturedAt: 1,
  pageUrl: "http://localhost:3000/app",
  dataUrl: "data:image/png;base64,AAAA",
};

function state(navStatus: ShellWebTabState["navStatus"]): ShellWebTabState {
  return {
    updatedAt: "2026-08-09T00:00:00.000Z",
    favicon,
    controller: "none",
    audible: false,
    audioMuted: false,
    colorScheme: "system",
    pictureInPicture: false,
    zoomFactor: 1,
    canGoForward: false,
    canGoBack: false,
    navStatus,
    webContentsId: 1,
    tabId: "tab-1",
  };
}

describe("projectShellState", () => {
  it("shows a retained icon only while the current document has the captured origin", () => {
    expect(
      projectShellState(state({ kind: "Loading", url: "http://localhost:3000/reload", title: "" }))
        .favicon,
    ).toEqual(favicon);
    expect(
      projectShellState(
        state({
          description: "failed",
          code: -105,
          title: "",
          url: "https://example.com/",
          kind: "LoadFailed",
        }),
      ).favicon,
    ).toBeNull();
    expect(projectShellState(state({ kind: "Idle" })).favicon).toBeNull();
  });
});
