import * as Electron from "electron";
import * as Context from "effect/Context";
import { MachineArchitecture } from "@kora/shared/hostMachine";

const hostArch = () => Context.get(Context.empty(), MachineArchitecture);

const isAppRosetta = () =>
  (Electron.app as unknown as { runningUnderRosettaTranslation?: boolean })
    .runningUnderRosettaTranslation === true ||
  (Electron.app as { runningUnderARM64Translation?: boolean }).runningUnderARM64Translation ===
    true;

export function isIntelWithoutRosetta(
  arch: string = hostArch(),
  isRosetta: boolean = isAppRosetta(),
): boolean {
  return arch !== "arm64" && !isRosetta;
}

export function enforceAppleSiliconGuard(
  dialog: { showErrorBox: (title: string, content: string) => void } = Electron.dialog,
  app: { quit: () => void } = Electron.app,
  arch: string = hostArch(),
  isRosetta: boolean = isAppRosetta(),
): boolean {
  if (isIntelWithoutRosetta(arch, isRosetta)) {
    dialog.showErrorBox("Kora", "Kora requires an Apple Silicon Mac");
    app.quit();
    return false;
  }
  return true;
}
