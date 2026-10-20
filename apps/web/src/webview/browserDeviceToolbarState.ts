import type { WebViewportSetting } from "@kora/contracts";

export async function commitViewportAndAspectRatio(
  preference: WebViewportSetting,
  ratio: number | null,
  onChange: (preference: WebViewportSetting) => Promise<void>,
  onAspectRatioChange: (ratio: number | null) => void,
): Promise<void> {
  await onChange(preference);
  onAspectRatioChange(ratio);
}
