import { errorLogFields } from "@kora/client-runtime/failures";

export type ResolvedTheme = "dark";

const DARK_RESULT = { resolvedTheme: "dark" } as const satisfies { resolvedTheme: ResolvedTheme };

const TRANSPARENT = new Set(["transparent", "rgba(0, 0, 0, 0)", "rgba(0 0 0 / 0)"]);

function usableColor(raw: string): string | null {
  const color = raw.trim();
  return color && !TRANSPARENT.has(color.toLowerCase()) ? color : null;
}

/** Paints html/body and the theme-color meta tag in the app frame colour. */
export function syncBrowserChromeTheme(): void {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const html = document.documentElement;
  const color =
    usableColor(getComputedStyle(html).getPropertyValue("--app-frame")) ??
    (document.body ? usableColor(getComputedStyle(document.body).backgroundColor) : null);
  if (!color) return;

  html.style.backgroundColor = color;
  if (document.body) document.body.style.backgroundColor = color;

  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (metas.length > 0) {
    for (const meta of metas) meta.setAttribute("content", color);
    return;
  }
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.dataset.dynamicThemeColor = "true";
  meta.content = color;
  document.head.appendChild(meta);
}

let shellNotified = false;

function syncShellTheme(): void {
  const bridge = typeof window === "undefined" ? undefined : window.shellBridge;
  if (shellNotified || typeof bridge?.setTheme !== "function") return;
  shellNotified = true;
  Promise.resolve(bridge.setTheme("dark")).catch((cause: unknown) => {
    shellNotified = false; // let a later call retry
    console.error("Failed to sync the dark theme to the desktop shell.", errorLogFields(cause));
  });
}

if (typeof document !== "undefined") {
  document.documentElement.classList.add("dark");
  syncBrowserChromeTheme();
  syncShellTheme();
}

export function useTheme(): { readonly resolvedTheme: ResolvedTheme } {
  return DARK_RESULT;
}
