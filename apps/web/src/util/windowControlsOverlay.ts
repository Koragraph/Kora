import { isWindowsPlatform } from "./utils";

const WCO_CLASS_NAME = "wco";
const NATIVE_CLASS_NAME = "electron";
const NATIVE_WINDOWS_CLASS_NAME = "native-windows";

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  addEventListener(typ: "geometrychange", subscriber: EventListener): void;
  removeEventListener(typ: "geometrychange", subscriber: EventListener): void;
}

type NavigatorWithWindowControlsOverlay = Navigator & {
  readonly windowControlsOverlay?: WindowControlsOverlayLike;
};

const noop = (): void => {};

function getWindowControlsOverlay(): WindowControlsOverlayLike | null {
  return typeof navigator !== "undefined"
    ? ((navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay ?? null)
    : null;
}

export function syncDocumentWindowControlsOverlayClass(): () => void {
  if (typeof document === "undefined") return noop;

  const overlay = getWindowControlsOverlay();
  const root = document.documentElement;
  const refresh = () => {
    root.classList.toggle(WCO_CLASS_NAME, overlay?.visible === true);
  };

  refresh();
  if (overlay === null) return noop;

  overlay.addEventListener("geometrychange", refresh);
  return () => overlay.removeEventListener("geometrychange", refresh);
}

function getNativePlatformClassNames(
  hostOs: string,
):
  | readonly [typeof NATIVE_CLASS_NAME]
  | readonly [typeof NATIVE_CLASS_NAME, typeof NATIVE_WINDOWS_CLASS_NAME] {
  if (!isWindowsPlatform(hostOs)) return [NATIVE_CLASS_NAME];
  return [NATIVE_CLASS_NAME, NATIVE_WINDOWS_CLASS_NAME];
}

export function syncDocumentNativePlatformClasses(hostOs: string): () => void {
  if (typeof document === "undefined") return noop;

  const applied = getNativePlatformClassNames(hostOs);
  const { classList } = document.documentElement;
  classList.add(...applied);
  return () => classList.remove(...applied);
}
