/**
 * Outfit picker: a big live blob (eyes follow the cursor, nods when the outfit changes), three rows
 * one row of accessory thumbnails (every accessory plus "none"; a blob wears at most one, so picking
 * replaces the previous), and a Shuffle button. The row is a radio group with roving focus: arrows
 * move + select, Home/End jump.
 */
import { ShuffleIcon } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useEffect, useRef } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import "./blobPicker.css";
import { BlobAvatar, type BlobAvatarHandle, type BlobVisualState } from "./BlobAvatar";
import {
  ACCESSORY_CHOICES,
  ACCESSORY_LABELS,
  type AccessoryChoice,
  type BlobOutfit,
  PICKABLE_ACCESSORY_CHOICES,
  shuffledOutfit,
} from "./outfit";

export interface OutfitPickerProps {
  value: BlobOutfit;
  onChange: (next: BlobOutfit) => void;
  /** The Chief may also wear the crown; everyone else may not. */
  chief?: boolean;
  /** State shown on the live preview (default idle). */
  previewState?: BlobVisualState;
  /** A shorter stage (the editor dialog): keeps the preview and Shuffle on screen at laptop heights. */
  compact?: boolean;
  className?: string;
}

const keyOf = (c: AccessoryChoice) => `${c.slot}:${c.id}`;
const currentKey = (value: BlobOutfit): string | undefined =>
  value.head ? `head:${value.head}` : value.face ? `face:${value.face}` : undefined;
const outfitFor = (c: AccessoryChoice | undefined): BlobOutfit =>
  !c ? {} : c.slot === "head" ? { head: c.id } : { face: c.id };

function NoneGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden className="blob-picker__none">
      <circle
        cx="12"
        cy="12"
        r="8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeDasharray="3 3"
      />
      <path d="M6.5 17.5 L17.5 6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function AccessoryRow({
  options,
  value,
  onPick,
}: {
  options: readonly AccessoryChoice[];
  value: string | undefined;
  onPick: (choice: AccessoryChoice | undefined) => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const choices: ReadonlyArray<AccessoryChoice | undefined> = [undefined, ...options];
  const selectedIndex = Math.max(
    0,
    choices.findIndex((c) => (c ? keyOf(c) : undefined) === value),
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next = selectedIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = (selectedIndex + 1) % choices.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (selectedIndex - 1 + choices.length) % choices.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = choices.length - 1;
    else return;
    event.preventDefault();
    onPick(choices[next]);
    groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div className="blob-picker__row">
      <div className="blob-picker__row-label" id="blob-picker-accessory">
        Accessory
      </div>
      <div
        ref={groupRef}
        className="blob-picker__options"
        style={{ "--blob-picker-cols": choices.length } as CSSProperties}
        role="radiogroup"
        aria-labelledby="blob-picker-accessory"
        onKeyDown={onKeyDown}
      >
        {choices.map((choice, index) => {
          const checked = index === selectedIndex;
          const name = choice ? ACCESSORY_LABELS[choice.id] : "None";
          return (
            <Tooltip key={choice ? keyOf(choice) : "none"}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={
                      choice
                        ? `${choice.slot === "head" ? "Head" : "Face"}: ${name}`
                        : "Accessory: None"
                    }
                    tabIndex={index === selectedIndex ? 0 : -1}
                    className="blob-picker__option"
                    data-checked={checked || undefined}
                    onClick={() => onPick(choice)}
                  />
                }
              >
                {choice === undefined ? (
                  <NoneGlyph />
                ) : (
                  <BlobAvatar size={24} still eyesFollowCursor={false} outfit={outfitFor(choice)} />
                )}
              </TooltipTrigger>
              <TooltipPopup side="top">{name}</TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

export function OutfitPicker({
  value,
  onChange,
  chief = false,
  previewState = "idle",
  compact = false,
  className,
}: OutfitPickerProps) {
  const previewRef = useRef<BlobAvatarHandle>(null);
  const signature = currentKey(value) ?? "";
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    previewRef.current?.play("nod");
  }, [signature]);

  return (
    <div className={["blob-picker", compact ? "blob-picker--compact" : "", className].filter(Boolean).join(" ")}>
      <div className="blob-picker__stage">
        <button
          type="button"
          className="blob-picker__preview"
          aria-label="Preview. Press to wave."
          onClick={() => previewRef.current?.play("wave")}
        >
          <BlobAvatar
            ref={previewRef}
            size={compact ? 96 : 144}
            chief={chief}
            outfit={value}
            state={previewState}
            eyesFollowCursor
          />
        </button>
        <Button
          variant="outline"
          size="sm"
          className="blob-picker__shuffle"
          onClick={() => onChange(shuffledOutfit(chief))}
          aria-label="Shuffle outfit"
        >
          <ShuffleIcon aria-hidden />
          Shuffle
        </Button>
      </div>
      <div className="blob-picker__rows">
        <AccessoryRow
          options={chief ? ACCESSORY_CHOICES : PICKABLE_ACCESSORY_CHOICES}
          value={currentKey(value)}
          onPick={(choice) => onChange(outfitFor(choice))}
        />
      </div>
    </div>
  );
}
