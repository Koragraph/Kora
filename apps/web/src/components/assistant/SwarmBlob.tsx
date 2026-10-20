/**
 * One worker in the dock: Kora's pixel sprite, still (no motion, no gestures), wearing its agent's accessory
 * (blobState.ts `agentAccessory`: headphones Claude, shades Codex, cap Antigravity, beanie OpenCode …). The frame says
 * the state (walk = working, "?" = needs you, ^^ = done, xx = failed, z = asleep); the only colour is a dot — amber
 * when it needs you, red when it failed. Nothing floats beside it: the hover hint is the task alone.
 */
import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useRef,
} from "react";

import { PixelSprite } from "~/components/sprite";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { SPRITE_STATE, type BlobViewModel } from "./blobState";

export interface SwarmBlobProps {
  readonly vm: BlobViewModel;
  readonly selected: boolean;
  readonly onOpen: (paneId: string) => void;
  /** Sprite box in px: live workers 36, the folded pile's 24. */
  readonly size?: number;
  readonly onContextMenu?: (paneId: string, position: { x: number; y: number }) => void;
  readonly onDragStart?: (paneId: string, event: ReactDragEvent<HTMLButtonElement>) => void;
  readonly onDragEnd?: () => void;
}

export function SwarmBlob({
  vm,
  selected,
  onOpen,
  size = 36,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: SwarmBlobProps) {
  const bodyRef = useRef<HTMLSpanElement>(null);

  const openContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!onContextMenu) return;
      event.preventDefault();
      onContextMenu(vm.paneId, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, vm.paneId],
  );

  const handleDragStart = useCallback(
    (event: ReactDragEvent<HTMLButtonElement>) => {
      if (!onDragStart) return;
      // The face follows the cursor: hand the browser the sprite's own node rather than a detached clone.
      if (bodyRef.current) event.dataTransfer.setDragImage(bodyRef.current, size / 2, size / 2);
      onDragStart(vm.paneId, event);
    },
    [onDragStart, size, vm.paneId],
  );

  const dot = vm.state === "blocked" ? "attn" : vm.state === "failed" ? "fail" : null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="swarm-blob"
            data-state={vm.state}
            data-selected={selected}
            data-pane-id={vm.paneId}
            draggable={onDragStart != null}
            aria-label={`Worker: ${vm.title}, ${vm.stateWord}`}
            style={{ width: size, height: size }}
            onClick={() => onOpen(vm.paneId)}
            onContextMenu={openContextMenu}
            onDragStart={handleDragStart}
            onDragEnd={onDragEnd}
          />
        }
      >
        <PixelSprite
          ref={bodyRef}
          className="swarm-blob__body"
          state={SPRITE_STATE[vm.state]}
          accessory={vm.accessory}
          size={size}
          still
        />
        {dot ? <span className="swarm-blob__dot" data-dot={dot} aria-hidden /> : null}
      </TooltipTrigger>
      <TooltipPopup side="left" className="swarm-blob-dock__tooltip">
        {vm.title}
      </TooltipPopup>
    </Tooltip>
  );
}
