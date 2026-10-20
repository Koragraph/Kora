import { useUpdateScopedPrefs, useScopedPrefsMixed, useScopedPrefs } from "./useScopedPrefs";
import { searchableSetting } from "./prefsSearch";
import { PrefsPageContainer, SettingResetButton, PrefsSection, PrefsRow } from "./prefsLayout";
import { ProjectDefaultsPrefs } from "./ProjectDefaultsPrefs";
import { usePrefsScope } from "./PrefsScopeContext";
import { NotificationPrefs } from "./NotificationPrefs";
import {
  BackgroundServicePrefsRow,
  CliPathPrefsRow,
  ReportBugPrefsRow,
  UninstallPrefsRow,
  UpdatesPrefsRow,
} from "./AboutPrefs";
import { Switch } from "../ui/switch";
import { SelectTrigger, SelectPopup, SelectValue, SelectItem, Select } from "../ui/select";
import { DraftInput } from "../ui/commit-input";
import { Button } from "../ui/button";
import { localApiOrThrow, readLocalApi } from "../../localApi";
import { APP_VERSION } from "../../branding";
import {
  DEFAULT_UNIFIED_PREFS,
  NAV_WORKING_STYLES,
  type NavWorkingStyle,
  type UnifiedPrefs,
} from "@kora/contracts/clientPrefs";
import { Link } from "@tanstack/react-router";

const WORKING_STYLE_LABELS: Record<NavWorkingStyle, string> = {
  outline: "Light round the outline",
  rail: "Rail on the left",
  line: "Line along the bottom",
  sweep: "Sheen sweeping across",
  pulse: "Breathing outline",
  dash: "Marching dashes",
  corners: "Blinking corners",
  scan: "Scan line",
  off: "Just Kora",
};

type RestorableKey =
  | "timestampFormat"
  | "notificationMode"
  | "inAppNotificationsEnabled"
  | "responseStreamingMode"
  | "showSkillsInSlashMenu"
  | "composerCollapseOnScroll"
  | "sidebarWorkingStyle"
  | "addProjectBaseDirectory"
  | "confirmThreadArchive"
  | "confirmThreadDelete";

const RESTORABLE: ReadonlyArray<readonly [RestorableKey, string]> = [
  ["timestampFormat", "Clock"],
  ["notificationMode", "Desktop alerts"],
  ["inAppNotificationsEnabled", "Heads-up inside Kora"],
  ["responseStreamingMode", "How replies arrive"],
  ["showSkillsInSlashMenu", "Skills in the / menu"],
  ["composerCollapseOnScroll", "Fold the prompt while reading"],
  ["sidebarWorkingStyle", "Working chats in the sidebar"],
  ["addProjectBaseDirectory", "New projects folder"],
  ["confirmThreadArchive", "Check before archiving"],
  ["confirmThreadDelete", "Check before deleting"],
];

export function usePrefsRestore(onRestored?: () => void): {
  changedSettingLabels: string[];
  restoreDefaults: () => Promise<void>;
} {
  const settings = useScopedPrefs();
  const update = useUpdateScopedPrefs();

  const changedSettingLabels = RESTORABLE.filter(
    ([key]) => settings[key] !== DEFAULT_UNIFIED_PREFS[key],
  ).map(([, label]) => label);

  const restoreDefaults = async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi() ?? localApiOrThrow();
    const question = [
      "Put these back the way Kora ships them?",
      `Resets: ${changedSettingLabels.join(", ")}.`,
    ].join("\n");
    const confirmed = await api.dialogs.confirm(question, { variant: "destructive" });
    if (!confirmed) {
      return;
    }
    update(
      Object.fromEntries(
        RESTORABLE.map(([key]) => [key, DEFAULT_UNIFIED_PREFS[key]]),
      ) as Partial<UnifiedPrefs>,
    );
    onRestored?.();
  };

  return { changedSettingLabels, restoreDefaults };
}

function ConfirmationRow(props: {
  id: string;
  title: string;
  description: string;
  settingKey: "confirmThreadArchive" | "confirmThreadDelete";
}) {
  const value = useScopedPrefs((settings) => settings[props.settingKey]);
  const update = useUpdateScopedPrefs();
  return (
    <PrefsRow
      id={props.id}
      title={props.title}
      description={props.description}
      resetAction={
        value !== DEFAULT_UNIFIED_PREFS[props.settingKey] ? (
          <SettingResetButton
            label={props.title}
            onClick={() => update({ [props.settingKey]: DEFAULT_UNIFIED_PREFS[props.settingKey] })}
          />
        ) : null
      }
      control={
        <Switch
          aria-label={props.title}
          checked={value}
          onCheckedChange={(checked) => update({ [props.settingKey]: Boolean(checked) })}
        />
      }
    />
  );
}

const RETENTION_OPTIONS = [7, 14, 30, 60, 90] as const;
const STREAMING_DESCRIPTIONS = {
  turn: "Nothing shows until the agent is done talking.",
  paragraph: "Text lands a paragraph (or a code block) at a time.",
  token: "Word by word, as it is written.",
} as const;

export function GeneralPrefsPanel() {
  const settings = useScopedPrefs();
  const update = useUpdateScopedPrefs();
  const { scope } = usePrefsScope();

  const baseDirRow = searchableSetting("add-project-starts-in");
  const inAppRow = searchableSetting("in-app-notifications");
  const clockRow = searchableSetting("time-format");
  const workingStyleRow = searchableSetting("sidebar-working-style");
  const streamingRow = searchableSetting("response-streaming");
  const skillsRow = searchableSetting("skills-in-slash-menu");
  const collapseRow = searchableSetting("composer-collapse");
  const diagnosticsRow = searchableSetting("diagnostics");
  const limitTelemetryRow = searchableSetting("claude-limit-telemetry");

  const baseDirMixed = useScopedPrefsMixed(["addProjectBaseDirectory"]);
  const streamingMixed = useScopedPrefsMixed(["responseStreamingMode"]);
  const retention = settings.workerBranchRetentionDays ?? 30;

  const diagnosticsHost = scope.hostIds.length === 1 ? scope.hostIds[0] : undefined;

  return (
    <PrefsPageContainer>
      <ProjectDefaultsPrefs />

      <PrefsSection id="workers" title="Workers">
        <PrefsRow
          control={
            <Select
              value={String(retention)}
              onValueChange={(value) => {
                if (value !== null) update({ workerBranchRetentionDays: Number(value) });
              }}
            >
              <SelectTrigger size="sm" aria-label="Keep sleeping workers' branches">
                <SelectValue>
                  {retention === 0 ? "Until I delete them" : `${retention} days`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false} align="end">
                {RETENTION_OPTIONS.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {days} days
                  </SelectItem>
                ))}
                <SelectItem value="0">Until I delete them</SelectItem>
              </SelectPopup>
            </Select>
          }
          description="A worker goes to sleep after 10 minutes idle: its process closes and its folder is removed, but its work stays on its branch and its transcript stays readable. Unmerged branches are deleted after this long."
          title="Keep sleeping workers' branches"
          id="worker-branch-retention"
        />
      </PrefsSection>

      <PrefsSection id="privacy" title="Privacy">
        <PrefsRow
          id={limitTelemetryRow.id}
          title={limitTelemetryRow.title}
          description="Claude Code talks to a second service besides Anthropic's API (usage analytics and feature flags). On, Claude sessions and Claude workers that Kora starts turn that off, along with Claude Code's own update check and error reports. Takes effect on the next session. Your own terminal's claude is not changed."
          control={
            <Switch
              aria-label="Limit Claude's background traffic"
              checked={settings.limitClaudeTelemetry === true}
              onCheckedChange={(checked) => update({ limitClaudeTelemetry: checked })}
            />
          }
        />
      </PrefsSection>

      <PrefsSection id="confirmations" title="Safety checks">
        <ConfirmationRow
          id="archive-confirmation"
          title="Check before archiving"
          description="The archive button on a chat row needs a second click."
          settingKey="confirmThreadArchive"
        />
        <ConfirmationRow
          id="delete-confirmation"
          title="Check before deleting"
          description="Deleting a chat, and everything said in it, asks first."
          settingKey="confirmThreadDelete"
        />
      </PrefsSection>

      <PrefsSection id="projects-and-threads" title="Projects">
        <PrefsRow
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              spellCheck={false}
              aria-label="New projects folder"
              placeholder={baseDirMixed ? "Mixed" : "~/"}
              value={baseDirMixed ? "" : settings.addProjectBaseDirectory}
              onCommit={(next) => update({ addProjectBaseDirectory: next })}
            />
          }
          resetAction={
            settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_PREFS.addProjectBaseDirectory ? (
              <SettingResetButton
                onClick={() =>
                  update({ addProjectBaseDirectory: DEFAULT_UNIFIED_PREFS.addProjectBaseDirectory })
                }
                label="add project base directory"
              />
            ) : null
          }
          description="The folder picker for a new project opens here. Empty means your home folder (~/)."
          settingKeys={["addProjectBaseDirectory"]}
          title={baseDirRow.title}
          mixed={baseDirMixed}
          id={baseDirRow.id}
          serverScoped
        />
        <PrefsRow
          control={
            <Select
              onValueChange={(value) => {
                const style = NAV_WORKING_STYLES.find((s) => s === value);
                if (style) update({ sidebarWorkingStyle: style });
              }}
              value={settings.sidebarWorkingStyle}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-48"
                aria-label="Working chats in the sidebar"
              >
                <SelectValue>{WORKING_STYLE_LABELS[settings.sidebarWorkingStyle]}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false} align="end">
                {NAV_WORKING_STYLES.map((style) => (
                  <SelectItem key={style} hideIndicator value={style}>
                    <span className="inline-flex items-center gap-2">
                      <span className="relative inline-block h-4 w-9 rounded-md bg-[var(--lift-bg)]">
                        <span
                          aria-hidden
                          className="nav-working-fx nav-working-fx-mini rounded-md"
                          data-style={style}
                        />
                      </span>
                      {WORKING_STYLE_LABELS[style]}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
          resetAction={
            settings.sidebarWorkingStyle !== DEFAULT_UNIFIED_PREFS.sidebarWorkingStyle ? (
              <SettingResetButton
                label="working chats in the sidebar"
                onClick={() =>
                  update({ sidebarWorkingStyle: DEFAULT_UNIFIED_PREFS.sidebarWorkingStyle })
                }
              />
            ) : null
          }
          description="How a chat card shows that its agent is working. Kora animates in the corner in every style."
          title={workingStyleRow.title}
          id={workingStyleRow.id}
        />
      </PrefsSection>

      <PrefsSection id="behavior" title="Chat">
        <NotificationPrefs />
        <PrefsRow
          id={inAppRow.id}
          title={inAppRow.title}
          description="While you are in Kora, a short note drops in when another chat is done, fails, or is waiting on you."
          control={
            <Switch
              aria-label="Heads-up inside Kora"
              checked={settings.inAppNotificationsEnabled}
              onCheckedChange={(checked) => update({ inAppNotificationsEnabled: checked })}
            />
          }
        />
        <PrefsRow
          control={
            <Select
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  update({ timestampFormat: value });
                }
              }}
              value={settings.timestampFormat}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>
                  {settings.timestampFormat === "locale"
                    ? "System default"
                    : settings.timestampFormat === "12-hour"
                      ? "12-hour"
                      : "24-hour"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false} align="end">
                <SelectItem value="locale" hideIndicator>
                  System default
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  12-hour
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  24-hour
                </SelectItem>
              </SelectPopup>
            </Select>
          }
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_PREFS.timestampFormat ? (
              <SettingResetButton
                label="clock"
                onClick={() => update({ timestampFormat: DEFAULT_UNIFIED_PREFS.timestampFormat })}
              />
            ) : null
          }
          description="System default follows your OS clock preference."
          title={clockRow.title}
          id={clockRow.id}
        />
        <PrefsRow
          control={
            <Select
              value={streamingMixed ? null : settings.responseStreamingMode}
              onValueChange={(value) => {
                // Only these two are writable; a stored "token" still displays.
                if (value === "turn" || value === "paragraph")
                  update({ responseStreamingMode: value });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="How replies arrive">
                <SelectValue>
                  {streamingMixed
                    ? "Mixed"
                    : settings.responseStreamingMode === "token"
                      ? "Token by token"
                      : settings.responseStreamingMode === "turn"
                        ? "All at once, when done"
                        : "A paragraph at a time"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false} align="end">
                <SelectItem hideIndicator value="turn">
                  All at once, when done
                </SelectItem>
                <SelectItem hideIndicator value="paragraph">
                  A paragraph at a time
                </SelectItem>
              </SelectPopup>
            </Select>
          }
          resetAction={
            settings.responseStreamingMode !== DEFAULT_UNIFIED_PREFS.responseStreamingMode ? (
              <SettingResetButton
                onClick={() =>
                  update({ responseStreamingMode: DEFAULT_UNIFIED_PREFS.responseStreamingMode })
                }
                label="response streaming"
              />
            ) : null
          }
          description={
            streamingMixed
              ? "The selected targets use different streaming modes."
              : STREAMING_DESCRIPTIONS[settings.responseStreamingMode]
          }
          settingKeys={["responseStreamingMode"]}
          title={streamingRow.title}
          mixed={streamingMixed}
          id={streamingRow.id}
          serverScoped
        />
        <PrefsRow
          id={skillsRow.id}
          title={skillsRow.title}
          description="List skills next to commands when you type /. Typing $ always lists them."
          control={
            <Switch
              aria-label="Skills in the / menu"
              checked={settings.showSkillsInSlashMenu}
              onCheckedChange={(checked) => update({ showSkillsInSlashMenu: checked })}
            />
          }
        />
        <PrefsRow
          id={collapseRow.id}
          title={collapseRow.title}
          description="Rest the composer into a single line when you scroll the conversation. Focus it or start typing to expand it again."
          control={
            <Switch
              aria-label="Fold the prompt while reading"
              checked={settings.composerCollapseOnScroll}
              onCheckedChange={(checked) => update({ composerCollapseOnScroll: checked })}
            />
          }
        />
      </PrefsSection>

      <PrefsSection title="Diagnostics">
        <PrefsRow
          id={diagnosticsRow.id}
          title={diagnosticsRow.title}
          description="Check the daemon, the code graph, and the agent CLIs on this machine."
          control={
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/settings/diagnostics"
                  search={(diagnosticsHost ? { machine: diagnosticsHost } : {}) as never}
                />
              }
            >
              Open diagnostics
            </Button>
          }
        />
        <CliPathPrefsRow />
        <BackgroundServicePrefsRow />
      </PrefsSection>

      <PrefsSection id="about" title="About">
        <PrefsRow
          title={
            <span className="inline-flex items-baseline gap-2">
              Version
              <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
            </span>
          }
          description="The build you are running."
        />
        <UpdatesPrefsRow />
        <ReportBugPrefsRow />
        <UninstallPrefsRow />
      </PrefsSection>
    </PrefsPageContainer>
  );
}
