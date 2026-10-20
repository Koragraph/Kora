import { useState, type FocusEvent, type FormEvent } from "react";
import { Link2, Unlink2, X } from "lucide-react";
import { WEB_VIEWPORT_PRESETS, resolveWebViewport } from "@kora/shared/webViewport";
import {
  type WebViewportSetting,
  WEB_VIEWPORT_MIN_DIMENSION,
  WEB_VIEWPORT_MAX_DIMENSION,
  WEB_VIEWPORT_MAX_AREA,
} from "@kora/contracts";

import { cn } from "~/util/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  SelectValue,
  SelectTrigger,
  SelectPopup,
  SelectItem,
  SelectGroupLabel,
  SelectGroup,
  Select,
} from "~/components/ui/select";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { ScreenRotationIcon } from "./ScreenRotationIcon";
import { commitViewportAndAspectRatio } from "./browserDeviceToolbarState";
import { resizeFreeformViewport, BROWSER_DEVICE_TOOLBAR_HEIGHT } from "./browserViewportLayout";

type FixedSetting = Exclude<WebViewportSetting, { readonly _tag: "fill" }>;
type Draft = { readonly width: string; readonly height: string };

const RESPONSIVE = "responsive";
const MIN = WEB_VIEWPORT_MIN_DIMENSION;
const MAX = WEB_VIEWPORT_MAX_DIMENSION;

const parseDimension = (str: string): number | null => {
  const val = Number(str);
  return str.trim() !== "" && Number.isInteger(val) && val >= MIN && val <= MAX ? val : null;
};

export function BrowserDeviceToolbar({
  onChange,
  onAspectRatioChange,
  aspectRatio,
  width,
  setting,
}: {
  readonly setting: FixedSetting;
  readonly width: number;
  readonly aspectRatio: number | null;
  readonly onAspectRatioChange: (ratio: number | null) => void;
  readonly onChange: (preference: WebViewportSetting) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);

  const shownWidth = draft?.width ?? String(setting.width);
  const shownHeight = draft?.height ?? String(setting.height);
  const draftWidth = parseDimension(shownWidth);
  const draftHeight = parseDimension(shownHeight);
  const valid =
    draftWidth !== null &&
    draftHeight !== null &&
    draftWidth * draftHeight <= WEB_VIEWPORT_MAX_AREA;
  const changed = valid && (draftWidth !== setting.width || draftHeight !== setting.height);

  const presetValue =
    setting._tag === "preset" && WEB_VIEWPORT_PRESETS.some((entry) => entry.id === setting.presetId)
      ? setting.presetId
      : RESPONSIVE;

  const apply = async (upcoming: WebViewportSetting, nextAspect: number | null = aspectRatio) => {
    setPending(true);
    try {
      await commitViewportAndAspectRatio(upcoming, nextAspect, onChange, onAspectRatioChange);
      setDraft(null);
    } catch {
      /* keep the draft so the user can try again */
    } finally {
      setPending(false);
    }
  };

  const onPresetChange = (val: string | null) => {
    if (!val) return;
    if (val === RESPONSIVE) {
      if (setting._tag === "freeform") return;
      void apply({ _tag: "freeform", width: setting.width, height: setting.height });
      return;
    }
    const preset = WEB_VIEWPORT_PRESETS.find((entry) => entry.id === val);
    if (!preset) return;
    void apply(
      resolveWebViewport({ mode: "preset", preset: preset.id }),
      aspectRatio === null ? null : preset.width / preset.height,
    );
  };

  const updateDimension = (axis: "width" | "height", str: string) => {
    const upcoming: Draft = { width: shownWidth, height: shownHeight, [axis]: str };
    const typed = parseDimension(str);
    if (aspectRatio !== null && typed !== null) {
      const live = axis === "width" ? setting.width : setting.height;
      const delta = typed - live;
      const resized = resizeFreeformViewport(
        setting,
        axis === "width" ? { x: delta, y: 0 } : { x: 0, y: delta },
        1,
        axis === "width" ? "east" : "south",
        aspectRatio,
      );
      setDraft({ width: String(resized.width), height: String(resized.height) });
      return;
    }
    setDraft(upcoming);
  };

  const commitDraft = () => {
    if (!changed || draftWidth === null || draftHeight === null) {
      setDraft(null);
      return;
    }
    void apply({ _tag: "freeform", width: draftWidth, height: draftHeight });
  };

  const onToolbarBlur = (evt: FocusEvent<HTMLDivElement>) => {
    const upcoming = evt.relatedTarget;
    if (upcoming instanceof Element && evt.currentTarget.contains(upcoming)) return;
    // The preset popup renders outside the toolbar; opening it is not leaving.
    const involvesSelectPopup = [upcoming, evt.target].some(
      (target) => target instanceof Element && target.closest('[data-slot="select-positioner"]'),
    );
    if (involvesSelectPopup) return;
    if (draft !== null) commitDraft();
  };

  const rotate = () => {
    const origin: FixedSetting =
      changed && draftWidth !== null && draftHeight !== null
        ? { _tag: "freeform", width: draftWidth, height: draftHeight }
        : setting;
    void apply(
      { ...origin, width: origin.height, height: origin.width } as FixedSetting,
      aspectRatio === null ? null : 1 / aspectRatio,
    );
  };

  const toggleAspect = () => {
    if (aspectRatio !== null) onAspectRatioChange(null);
    else if (valid) onAspectRatioChange(draftWidth! / draftHeight!);
  };

  const inputWidth = width >= 360 ? "w-14" : "w-11";
  const dimensionInput = (axis: "width" | "height", val: string) => (
    <Input
      nativeInput
      type="number"
      inputMode="numeric"
      size="sm"
      min={MIN}
      max={MAX}
      value={val}
      disabled={pending}
      aria-label={axis === "width" ? "Viewport width" : "Viewport height"}
      aria-invalid={!valid || undefined}
      className={cn(
        "h-6 rounded-md text-center text-xs leading-none tabular-nums",
        inputWidth,
        "[&_input]:h-full [&_input]:px-1 [&_input]:text-center [&_input]:text-xs [&_input]:leading-none",
        "[&_input::-webkit-inner-spin-button]:appearance-none [&_input::-webkit-outer-spin-button]:appearance-none [&_input]:[appearance:textfield]",
      )}
      onFocus={() => setDraft((current) => current ?? { width: shownWidth, height: shownHeight })}
      onChange={(evt) => updateDimension(axis, evt.currentTarget.value)}
    />
  );

  const ratioLocked = aspectRatio !== null;

  return (
    <div
      style={{ width, height: BROWSER_DEVICE_TOOLBAR_HEIGHT }}
      className={cn(
        "sticky left-0 top-0 z-50 flex items-center gap-0.5 overflow-x-auto px-1.5",
        "border-b border-border/70 bg-background/95 shadow-xs backdrop-blur-md",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
      onBlur={onToolbarBlur}
      data-browser-device-toolbar
      aria-label="Browser device toolbar"
      role="toolbar"
    >
      {width >= 560 ? (
        <span className="mr-0.5 shrink-0 text-[11px] font-medium text-muted-foreground">
          Dimensions
        </span>
      ) : null}
      <Select modal={false} value={presetValue} onValueChange={onPresetChange} disabled={pending}>
        <SelectTrigger
          variant="ghost"
          size="xs"
          aria-label="Browser device preset"
          className={cn(
            "shrink-0 justify-between px-1.5 font-medium",
            width >= 440 ? "w-36" : "w-24",
          )}
        >
          <SelectValue>
            {presetValue === RESPONSIVE
              ? "Responsive"
              : (WEB_VIEWPORT_PRESETS.find((entry) => entry.id === presetValue)?.label ??
                "Responsive")}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false} className="min-w-64">
          <SelectItem value={RESPONSIVE}>Responsive</SelectItem>
          <SelectGroup>
            <SelectGroupLabel>Standard</SelectGroupLabel>
            {WEB_VIEWPORT_PRESETS.map((preset) => (
              <SelectItem value={preset.id} key={preset.id}>
                <span className="flex w-full items-center justify-between gap-5">
                  <span>{preset.label}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {preset.detail}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectPopup>
      </Select>
      <form
        aria-label="Viewport dimensions"
        className="m-0 flex shrink-0 items-center gap-0.5 border-0 p-0"
        onSubmit={(evt: FormEvent) => {
          evt.preventDefault();
          commitDraft();
        }}
      >
        {dimensionInput("width", shownWidth)}
        <span className="text-xs text-muted-foreground">×</span>
        {dimensionInput("height", shownHeight)}
      </form>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`${ratioLocked ? "Unlock" : "Lock"} viewport aspect ratio`}
              aria-pressed={ratioLocked}
              disabled={pending || !valid}
              className={cn(ratioLocked && "bg-accent text-foreground")}
              // Keep input focus so the draft is not committed by the blur.
              onPointerDown={(evt) => evt.preventDefault()}
              onClick={toggleAspect}
            />
          }
        >
          {ratioLocked ? <Link2 /> : <Unlink2 />}
        </TooltipTrigger>
        <TooltipPopup side="top">{ratioLocked ? "Unlock" : "Lock"} aspect ratio</TooltipPopup>
      </Tooltip>
      <Button
        onClick={rotate}
        onPointerDown={(evt) => evt.preventDefault()}
        disabled={pending}
        aria-label="Rotate viewport"
        size="icon-xs"
        variant="ghost"
      >
        <ScreenRotationIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close device toolbar"
        disabled={pending}
        className="sticky right-0 ml-auto shrink-0 bg-background/95"
        onClick={() => void apply({ _tag: "fill" }, null)}
      >
        <X />
      </Button>
    </div>
  );
}
