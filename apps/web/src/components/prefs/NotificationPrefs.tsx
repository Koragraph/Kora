import { useUpdateScopedPrefs, useScopedPrefs } from "./useScopedPrefs";
import { searchableSetting } from "./prefsSearch";
import { PrefsRow } from "./prefsLayout";
import { SelectTrigger, SelectPopup, SelectValue, SelectItem, Select } from "../ui/select";
import {
  NOTIFICATION_MODE_LABELS,
  unlockNotificationAudio,
  hasShellNotifications,
  hasNotificationSound,
} from "../../thread/threadNotifications";
import { useState } from "react";

const MSG_UNSUPPORTED_CONTEXT =
  "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.";
const MSG_PERMISSION_DENIED =
  "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.";
const MSG_PERMISSION_UNAVAILABLE =
  "Notifications are unavailable in this browser. Sound only is still available.";

export function NotificationPrefs() {
  const mode = useScopedPrefs((settings) => settings.notificationMode);
  const updatePrefs = useUpdateScopedPrefs();
  const [requesting, setRequesting] = useState(false);
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);

  const isMode = (candidate: unknown): candidate is typeof mode =>
    candidate === "off" ||
    candidate === "sound" ||
    candidate === "notifications" ||
    candidate === "notifications-and-sound";

  /** Asks the browser for permission; resolves to the message to show when it cannot be granted. */
  const askForPermission = async (): Promise<string | null> => {
    if (typeof Notification === "undefined" || !window.isSecureContext) {
      return MSG_UNSUPPORTED_CONTEXT;
    }
    setRequesting(true);
    try {
      const permission = await Notification.requestPermission();
      return permission === "granted" ? null : MSG_PERMISSION_DENIED;
    } catch {
      return MSG_PERMISSION_UNAVAILABLE;
    } finally {
      setRequesting(false);
    }
  };

  const chooseMode = async (value: unknown) => {
    if (!isMode(value)) {
      return;
    }
    setPermissionMessage(null);
    if (hasNotificationSound(value)) {
      unlockNotificationAudio();
    }
    if (hasShellNotifications(value)) {
      const refusal = await askForPermission();
      if (refusal !== null) {
        setPermissionMessage(refusal);
        return;
      }
    }
    updatePrefs({ notificationMode: value });
  };

  return (
    <PrefsRow
      {...searchableSetting("thread-notifications")}
      control={
        <Select value={mode} onValueChange={chooseMode} disabled={requesting}>
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Desktop alerts">
            <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false} align="end">
            {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
              <SelectItem value={value} hideIndicator key={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
      description={
        permissionMessage ??
        "macOS notifications when a chat is done, fails, or is waiting on you. Kora must be running (it can be in the background)."
      }
    />
  );
}
