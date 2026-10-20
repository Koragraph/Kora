import { APP_STAGE_LABEL } from "../../branding";

/** The sidebar's build pill: "Dev" in a Dev build, nothing in a release. */
export function stagePillLabel(stageLabel: string = APP_STAGE_LABEL): "Dev" | null {
  return stageLabel.trim().toLowerCase() === "dev" ? "Dev" : null;
}
