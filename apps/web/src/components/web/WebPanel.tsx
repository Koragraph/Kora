"use client";

import type { WebMarkupPayload, HostThreadRef } from "@kora/contracts";

import { isWebSupportedInRuntime } from "~/stores/webStateStore";

import { WebPanelShell, type WebPanelMode } from "./WebPanelShell";
import { WebView } from "./WebView";

interface Props {
  mode: WebPanelMode;
  threadRef: HostThreadRef;
  tabId?: string | null;
  visible: boolean;
  onSendAnnotation?: (annotation: WebMarkupPayload) => void;
}

export function WebPanel({ mode, threadRef, tabId, visible, onSendAnnotation }: Props) {
  if (!isWebSupportedInRuntime()) {
    return (
      <WebPanelShell mode={mode}>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            Preview is only available in the Kora desktop app.
          </p>
        </div>
      </WebPanelShell>
    );
  }

  return (
    <WebPanelShell mode={mode}>
      <WebView
        threadRef={threadRef}
        {...(tabId !== undefined ? { tabId } : {})}
        visible={visible}
        {...(onSendAnnotation ? { onSendAnnotation } : {})}
      />
    </WebPanelShell>
  );
}
