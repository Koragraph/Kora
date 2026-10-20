/// <reference types="vite-plus/client" />

import type { ShellBridge } from "@kora/contracts";

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    shellBridge?: ShellBridge;
    /** Desktop only: registers agent HTML for the `kora-preview://` origin (apps/desktop/src/preload.ts). */
    koraHtmlPreview?: { readonly register: (html: string) => Promise<string> };
  }
}
