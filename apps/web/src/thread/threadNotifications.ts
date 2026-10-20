import type { NotificationMode } from "@kora/contracts/clientPrefs";

import inputSoundUrl from "../assets/needs-input.m4a";
import completionSoundUrl from "../assets/turn-complete.m4a";

export const NOTIFICATION_MODE_LABELS: Record<NotificationMode, string> = {
  "notifications-and-sound": "Notifications with sound",
  sound: "Sound only",
  notifications: "Notifications only",
  off: "Off",
};

export const hasNotificationSound = (flavor: NotificationMode): boolean =>
  flavor === "sound" || flavor === "notifications-and-sound";

export const hasShellNotifications = (flavor: NotificationMode): boolean =>
  flavor === "notifications" || flavor === "notifications-and-sound";

// ---------- badge ----------

const BADGE_SIZE = 64;

function drawBadge(tally: number): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = BADGE_SIZE;
  canvas.height = BADGE_SIZE;
  const cx = canvas.getContext("2d");
  if (!cx) return null;
  cx.fillStyle = "#e5484d";
  cx.beginPath();
  cx.arc(32, 32, 28, 0, Math.PI * 2);
  cx.fill();
  cx.fillStyle = "#ffffff";
  cx.font = `600 ${tally > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
  cx.textAlign = "center";
  cx.textBaseline = "middle";
  cx.fillText(tally > 9 ? "9+" : String(tally), 32, 34);
  return canvas.toDataURL("image/png");
}

let originalIcon: HTMLLinkElement | null = null;
let badgeIcon: HTMLLinkElement | null = null;

function swapFavicon(img: string | null): void {
  if (img) {
    if (!badgeIcon) {
      originalIcon ??= document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
      originalIcon?.remove();
      badgeIcon = document.createElement("link");
      badgeIcon.rel = "icon";
      badgeIcon.type = "image/png";
      badgeIcon.setAttribute("sizes", "64x64");
      document.head.appendChild(badgeIcon);
    }
    badgeIcon.href = img;
    return;
  }
  if (badgeIcon) {
    badgeIcon.remove();
    badgeIcon = null;
    if (originalIcon) document.head.appendChild(originalIcon);
  }
}

export function setNotificationBadge(tally: number): void {
  const bridge = window.shellBridge;
  // macOS desktop uses the OS dock badge; only a browser tab or a Windows overlay needs a drawn image.
  const needsImage = tally > 0 && (!bridge || bridge.getClientPlatform?.() === "win32");
  const img = needsImage ? drawBadge(tally) : null;
  if (!bridge) swapFavicon(img);
  void Promise.resolve(bridge?.setNotificationBadge?.({ count: tally, image: img })).catch(
    () => undefined,
  );
}

// ---------- sound ----------

let audioContext: AudioContext | null = null;
const decodedBuffers = new Map<string, Promise<AudioBuffer>>();

/** Browsers only allow audio after a gesture: call this from one. */
export function unlockNotificationAudio(): void {
  try {
    audioContext ??= new AudioContext();
    void audioContext.resume().catch(() => undefined);
  } catch {
    /* no Web Audio */
  }
}

function loadBuffer(context1: AudioContext, address: string): Promise<AudioBuffer> {
  let queued = decodedBuffers.get(address);
  if (!queued) {
    queued = fetch(address)
      .then((resp) => resp.arrayBuffer())
      .then((blob) => context1.decodeAudioData(blob));
    decodedBuffers.set(address, queued);
  }
  return queued;
}

export async function playNotificationSound(
  variant: "completion" | "input",
  shouldPlay: () => boolean,
): Promise<void> {
  const context1 = audioContext;
  if (!context1 || context1.state !== "running") return;
  const address = variant === "completion" ? completionSoundUrl : inputSoundUrl;
  try {
    const bufr = await loadBuffer(context1, address);
    if (!shouldPlay() || context1.state !== "running") return;
    const origin = context1.createBufferSource();
    origin.buffer = bufr;
    origin.connect(context1.destination);
    origin.start();
  } catch {
    decodedBuffers.delete(address); // allow a retry
  }
}
