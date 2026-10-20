import type { AppearanceContrast } from "@kora/contracts/clientPrefs";

export function applyAppearanceContrast(baseDir: HTMLElement, contrast: AppearanceContrast): void {
  baseDir.style.setProperty("--appearance-contrast-base", `${Math.min(contrast, 100)}%`);
  baseDir.style.setProperty("--appearance-contrast-boost", `${Math.max(contrast - 100, 0)}%`);
  baseDir.style.setProperty(
    "--appearance-contrast-border-boost",
    `${Math.max(contrast - 100, 0) / 4}%`,
  );
}
