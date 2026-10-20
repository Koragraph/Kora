import type { ReactNode } from "react";
import { CircleAlertIcon } from "lucide-react";
import { useScopedPrefsMixed, useScopedPrefs, useUpdateScopedPrefs } from "./useScopedPrefs";
import { searchableSetting } from "./prefsSearch";
import { SettingResetButton, PrefsSection, PrefsRow } from "./prefsLayout";
import { SelectTrigger, SelectPopup, SelectValue, SelectItem, Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { DEFAULT_DAEMON_PREFS } from "@kora/contracts";

const SECTION = searchableSetting("token-savings");
const BOUNDED_ROW = searchableSetting("bounded-reads");
const BASH_ROW = searchableSetting("bash-trim");
const WARM_ROW = searchableSetting("cache-warm");
const BUGPROSE_ROW = searchableSetting("inject-bug-prose");
const LEAN_ROW = searchableSetting("lean-context");
const COLD_ROW = searchableSetting("cold-resume-masking");
const BOUNDARY_ROW = searchableSetting("task-boundary-chip");
const SWITCH_ROW = searchableSetting("model-switch-chip");
const STUCK_ROW = searchableSetting("runaway-guard");
const RECALL_ROW = searchableSetting("inject-recall");
const QUICK_ROW = searchableSetting("quick-answers");
const AUTO_ROW = searchableSetting("auto-model");
const AUTO_SONNET_ROW = searchableSetting("auto-sonnet");
const AUTO_HEADROOM_ROW = searchableSetting("auto-headroom");
const AUTO_EFFORT_ROW = searchableSetting("auto-effort");
const HANDOFF_ROW = searchableSetting("lead-handoff");
const CODEX_ROW = searchableSetting("codex-savings");
const CEILING_ROW = searchableSetting("swarm-token-ceiling");

const MODE_LABELS = { off: "Off", shadow: "Shadow (log only)", on: "On" } as const;
type Mode = keyof typeof MODE_LABELS;

type SwitchKey =
  | "leanContext"
  | "coldResumeMasking"
  | "taskBoundaryChip"
  | "modelSwitchChip"
  | "runawayGuard"
  | "injectRecall"
  | "quickAnswers"
  | "autoModel"
  | "autoSonnet"
  | "autoHeadroom"
  | "autoEffort"
  | "leadHandoff"
  | "codexSavings";
type ModeKey = "boundedReads" | "bashTrim" | "cacheWarm" | "injectBugProse";

// Fresh tokens one Swarm worker may use (input + output + cache writes, never cache reads) before it is told to stop exploring.
const CEILING_CHOICES: ReadonlyArray<{ readonly value: number; readonly label: string }> = [
  { value: 0, label: "No limit" },
  { value: 1000000, label: "1M" },
  { value: 2500000, label: "2.5M (recommended)" },
  { value: 5000000, label: "5M" },
];

/** Every switch that exists to make the same work cost fewer tokens, in one place, each with one honest line. */
export function TokenSavingsPrefs() {
  return (
    <PrefsSection id={SECTION.id} title="Cost and context">
      <SwitchRow
        row={AUTO_ROW}
        settingKey="autoModel"
        description="Pick Auto in the model menu and Kora chooses per chat from your first message: light work (a question about the code, a lookup, a one-place edit, a commit or a test run) runs on Haiku 5.5, about 1/20 of Sonnet's price per token; anything else runs on your Default. A light chat moves up to your Default if you say the answer was wrong, ask for a stronger model, or start real work in it. Off by default: in real use it saves little, because a chat that starts light usually turns into real work and has to move up. While it is off, picking Auto runs your Default. Claude chats only."
      />
      <SwitchRow
        row={AUTO_SONNET_ROW}
        settingKey="autoSonnet"
        description="With Auto on and Opus (or Fable) as your Default, ordinary work runs on Sonnet 5.5 at high effort instead: about half the price per token, and a few points lower on hard coding benchmarks (Anthropic: 87.6% vs 92.8%). Asking for a stronger model, ultrathink, saying an answer was wrong or a stuck turn moves the chat to your Default. Off by default; picking Opus in the model menu always runs Opus."
      />
      <SwitchRow
        row={AUTO_HEADROOM_ROW}
        settingKey="autoHeadroom"
        description="With Auto on and Opus (or Fable) as your Default: while one of your Claude plan limits (the 5-hour window or a weekly one) is at 85% or more, new chats doing ordinary work start on Sonnet 5.5 at high effort, which uses about half as much of your plan, so you keep working instead of hitting the limit. A chat that is already running is never switched, the chat says why, and picking Opus always runs Opus."
      />
      <SwitchRow
        row={AUTO_EFFORT_ROW}
        settingKey="autoEffort"
        description="With Auto on, a message that is only a chore (commit, push, run the tests) runs at low effort, and if that turn goes wrong your next message runs at high once. Everything else keeps your own effort, and a High or higher pick is never lowered. A small saving (a few percent), so off by default."
      />
      <SwitchRow
        row={HANDOFF_ROW}
        settingKey="leadHandoff"
        description="Every command Claude runs in a chat re-reads the whole conversation, so in a long chat a run of five or more commands for one step (a build or test loop, git chores, the same edit across files) costs far less in a fresh worker on Haiku or Sonnet. With this on, Claude is told so, and offers such runs to a worker through the usual worker picker; you still approve every worker. Off by default: more worker pickers, and a worker does not know everything the chat knows."
      />
      <ModeRow
        row={BOUNDED_ROW}
        settingKey="boundedReads"
        description="When Claude opens a whole long source file in an indexed project, Kora reads a window around the code it is looking for and hands over the file's outline. Reading the same file again gets all of it. Shadow (the default for now) only records what it would have saved and changes nothing."
      />
      <ModeRow
        row={BASH_ROW}
        settingKey="bashTrim"
        description="A command that prints more than 8,000 characters is cut to its first lines, every error or warning line and its last lines, and the full text is saved to a file whose path Claude is given. On is the default. Shadow only records what it would have saved and changes nothing. Claude threads only."
      />
      <ModeRow
        row={WARM_ROW}
        settingKey="cacheWarm"
        description={
          <span className="block space-y-2">
            <span className="block">
              Claude remembers a chat's context for an hour. If you leave and come back after that,
              the whole context is paid for again at the higher rate. With this on, Kora routes
              Claude chats through a small local relay that re-reads the context (a cheap cache
              read, no new answer) shortly before the hour is up, but only when a return is likely,
              and stops after about two hours. Shadow (recommended to try first) only records what
              it would have done.
            </span>
            <span className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/8 p-2.5 text-xs text-warning-foreground">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <span>
                <strong>Warning:</strong> Turning this on relays your Claude login headers through a
                local loopback proxy and may conflict with Anthropic's terms. Kept off by default;
                if enabled, use an API key rather than a subscription login.
              </span>
            </span>
            <span className="block text-muted-foreground text-xs">
              Applies to Claude chats started after you change it. Not used when you point Claude at
              your own gateway or proxy.
            </span>
          </span>
        }
      />
      <ModeRow
        row={BUGPROSE_ROW}
        settingKey="injectBugProse"
        description="When you describe a bug in plain words without naming any code (the retry count is off by one in the http client), Kora can hand your agent the two or three declarations most likely to be involved, only when one is clearly ahead, so the agent does not search the whole project first. Shadow (the default for now) only records what it would have handed over and changes nothing."
      />
      <SwitchRow
        row={LEAN_ROW}
        settingKey="leanContext"
        description="New Claude chats start without your installed skills and Claude's auto-memory, which saves roughly 10k tokens on every message but means Claude will not know your skills or past memories in those chats. Off by default. Chats you already started are not changed."
      />
      <SwitchRow
        row={COLD_ROW}
        settingKey="coldResumeMasking"
        description="When you come back to a Claude chat after more than an hour, its saved context has to be paid for again in full. Kora then continues from a copy where old file reads and command output are replaced by one-line stubs (recent turns, edits and errors stay). Your original conversation is kept, and a line in the chat says what was trimmed."
      />
      <SwitchRow
        row={BOUNDARY_ROW}
        settingKey="taskBoundaryChip"
        description="When a long chat (over 60k tokens) is about to start something unrelated, a banner offers to compact first or to start a fresh chat with a short brief. It never does either by itself, and a compaction can be undone."
      />
      <SwitchRow
        row={SWITCH_ROW}
        settingKey="modelSwitchChip"
        description="Switching models in the middle of a chat throws away its saved context. A line in the chat says how much was re-cached, so a new chat can be the cheaper choice next time. The switch is never blocked."
      />
      <SwitchRow
        row={STUCK_ROW}
        settingKey="runawayGuard"
        description="A line appears when a turn reads the same file three times or fails the same command three times, so you can press Stop before it burns more tokens. Nothing is stopped for you."
      />
      <SwitchRow
        row={RECALL_ROW}
        settingKey="injectRecall"
        description="Kora already hands Claude, Codex and Antigravity the right declarations when you name code. This also covers requests that name nothing (make the stop button red) and follow-ups like that file, so the agent does not search for what Kora already knows."
      />
      <SwitchRow
        row={QUICK_ROW}
        settingKey="quickAnswers"
        description="A message that is only who calls X, where is X defined or what breaks if I rename X, in an indexed project, is answered from the code graph right away with no agent turn. A Send to agent anyway button is on the answer, and anything that is not clearly such a question goes to the agent as usual."
      />
      <SwitchRow
        row={CODEX_ROW}
        settingKey="codexSavings"
        description="Codex turns carry a cap on how much one tool result may return and an earlier auto-compact point, and Codex features you do not use here (browser, computer use, image generation) are switched off. Settings in your own Codex config always win."
      />
      <CeilingRow />
    </PrefsSection>
  );
}

function SwitchRow(props: {
  readonly row: { readonly id: string; readonly title: string };
  readonly settingKey: SwitchKey;
  readonly description: string;
}) {
  const settings = useScopedPrefs();
  const update = useUpdateScopedPrefs();
  const key = props.settingKey;
  const mixed = useScopedPrefsMixed([key]);
  return (
    <PrefsRow
      id={props.row.id}
      title={props.row.title}
      serverScoped
      settingKeys={[key]}
      mixed={mixed}
      description={props.description}
      resetAction={
        settings[key] !== DEFAULT_DAEMON_PREFS[key] ? (
          <SettingResetButton
            onClick={() => update({ [key]: DEFAULT_DAEMON_PREFS[key] })}
            label={props.row.title.toLowerCase()}
          />
        ) : null
      }
      control={
        <Switch
          aria-label={props.row.title}
          checked={settings[key] === true}
          onCheckedChange={(checked) => update({ [key]: checked })}
        />
      }
    />
  );
}

function ModeRow(props: {
  readonly row: { readonly id: string; readonly title: string };
  readonly settingKey: ModeKey;
  readonly description: ReactNode;
}) {
  const settings = useScopedPrefs();
  const update = useUpdateScopedPrefs();
  const key = props.settingKey;
  const mixed = useScopedPrefsMixed([key]);
  return (
    <PrefsRow
      id={props.row.id}
      title={props.row.title}
      serverScoped
      settingKeys={[key]}
      mixed={mixed}
      description={props.description}
      resetAction={
        settings[key] !== DEFAULT_DAEMON_PREFS[key] ? (
          <SettingResetButton
            onClick={() => update({ [key]: DEFAULT_DAEMON_PREFS[key] })}
            label={props.row.title.toLowerCase()}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : settings[key]}
          onValueChange={(value) => {
            if (value === "off" || value === "shadow" || value === "on") {
              update({ [key]: value as Mode });
            }
          }}
        >
          <SelectTrigger size="sm" aria-label={props.row.title}>
            <SelectValue>{mixed ? "Mixed" : MODE_LABELS[settings[key]]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false} align="end">
            {(["off", "shadow", "on"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {MODE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function CeilingRow() {
  const settings = useScopedPrefs();
  const update = useUpdateScopedPrefs();
  const mixed = useScopedPrefsMixed(["swarmTokenCeiling"]);
  const current = settings.swarmTokenCeiling;
  const label = (n: number) =>
    CEILING_CHOICES.find((c) => c.value === n)?.label ?? `${n.toLocaleString()} tokens`;
  const options = CEILING_CHOICES.some((c) => c.value === current)
    ? CEILING_CHOICES
    : [...CEILING_CHOICES, { value: current, label: label(current) }];
  return (
    <PrefsRow
      id={CEILING_ROW.id}
      title="Swarm worker token limit"
      serverScoped
      settingKeys={["swarmTokenCeiling"]}
      mixed={mixed}
      description="A Swarm worker that has used this many fresh tokens is told to stop searching and finish its edit and report. It can still edit and run commands. It stops a worker that wanders, never one that is working."
      resetAction={
        current !== DEFAULT_DAEMON_PREFS.swarmTokenCeiling ? (
          <SettingResetButton
            onClick={() => update({ swarmTokenCeiling: DEFAULT_DAEMON_PREFS.swarmTokenCeiling })}
            label="swarm worker token limit"
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : String(current)}
          onValueChange={(value) => {
            const n = Number(value);
            if (Number.isInteger(n) && n >= 0) update({ swarmTokenCeiling: n });
          }}
        >
          <SelectTrigger size="sm" aria-label="Swarm worker token limit">
            <SelectValue>{mixed ? "Mixed" : label(current)}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false} align="end">
            {options.map((c) => (
              <SelectItem key={c.value} value={String(c.value)}>
                {c.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
