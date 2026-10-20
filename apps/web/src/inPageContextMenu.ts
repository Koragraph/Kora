import type { ContextMenuItem } from "@kora/contracts";

// Lucide glyph bodies (24x24, stroke currentColor), keyed by icon name.
const ICON_BODIES: Record<string, string> = {
  archive:
    '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  pencil:
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  "git-branch":
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  hash: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  "mail-open":
    '<path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z"/><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"/>',
  "message-square-plus":
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6"/><path d="M9 10h6"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  "pin-off":
    '<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>',
  share:
    '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/>',
  "refresh-cw":
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  "folder-tree":
    '<path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
};

function iconMarkup(name: string | undefined, sizeClass: string): string {
  const markup = name ? ICON_BODIES[name] : undefined;
  if (!markup) return "";
  return `<svg class="${sizeClass}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${markup}</svg>`;
}

const ICON_SIZE = "size-[18px] sm:size-4";
const EDGE_MARGIN = 4;
const SUBMENU_GAP = 4;

const ROW_CLASS =
  "flex w-full min-h-8 cursor-default select-none items-center gap-2 rounded-sm border-0 px-2 py-1 text-left text-base transition-colors sm:min-h-7 sm:text-sm";

interface Level {
  readonly root: HTMLElement;
  readonly scroller: HTMLElement;
  readonly trigger: HTMLElement | null;
}

interface Session {
  close(choice: string | null): void;
}

let activeSession: Session | null = null;

export function dismissContextMenu(): void {
  activeSession?.close(null);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(val, max));
}

export function showContextMenuFallback<Item extends string>(
  elems: readonly ContextMenuItem<Item>[],
  place: { x: number; y: number } = { x: 0, y: 0 },
): Promise<Item | null> {
  activeSession?.close(null);

  return new Promise<Item | null>((resolve) => {
    const levels: Level[] = [];
    const owned = new Set<Element>();
    const previouslyFocused = document.activeElement;
    let armed = false;
    let finished = false;

    const make = <Key0 extends keyof HTMLElementTagNameMap>(marker: Key0, className = "") => {
      const el = document.createElement(marker);
      el.className = className;
      owned.add(el);
      return el;
    };

    function closeLevelsFrom(depth: number) {
      while (levels.length > depth) {
        const level = levels.pop()!;
        level.trigger?.setAttribute("aria-expanded", "false");
        level.root.remove();
      }
    }

    function finish(choice: string | null) {
      if (finished) return;
      finished = true;
      if (activeSession === sess) activeSession = null;
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("keydown", onKeyDown, true);
      const focusWasInside = document.activeElement !== null && owned.has(document.activeElement);
      closeLevelsFrom(0);
      if (
        focusWasInside &&
        previouslyFocused instanceof HTMLElement &&
        previouslyFocused.isConnected
      ) {
        previouslyFocused.focus({ preventScroll: true });
      }
      resolve(choice as Item | null);
    }

    const sess: Session = { close: finish };

    function insideStack(dest: EventTarget | null): boolean {
      return levels.some((l) => dest instanceof Node && l.root.contains(dest));
    }
    function onPointerDown(evt: Event) {
      if (armed && !insideStack(evt.target)) finish(null);
    }
    function onContextMenu(evt: Event) {
      if (!insideStack(evt.target)) {
        evt.preventDefault();
        finish(null);
      }
    }

    const levelButtons = (level: Level | undefined) =>
      Array.from(level?.scroller.querySelectorAll("button") ?? []).filter((b) => !b.disabled);

    // Keyboard: Escape closes (a submenu first), arrows move between rows, Tab leaves. Without this the menu could
    // only be dismissed with the pointer, and a keyboard user was stuck in it.
    function onKeyDown(evt: KeyboardEvent) {
      const depth = levels.findIndex((l) =>
        levelButtons(l).includes(document.activeElement as never),
      );
      if (evt.key === "Escape") {
        evt.preventDefault();
        evt.stopPropagation();
        if (depth > 0) {
          const trigger = levels[depth]!.trigger;
          closeLevelsFrom(depth);
          trigger?.focus({ preventScroll: true });
          return;
        }
        const back = previouslyFocused;
        finish(null);
        if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
        return;
      }
      if (evt.key === "Tab") {
        finish(null);
        return;
      }
      if (evt.key === "ArrowRight") {
        const focused = document.activeElement;
        if (depth >= 0 && focused instanceof HTMLElement && focused.getAttribute("aria-haspopup")) {
          evt.preventDefault();
          focused.click();
        }
        return;
      }
      if (evt.key !== "ArrowDown" && evt.key !== "ArrowUp" && evt.key !== "ArrowLeft") return;
      evt.preventDefault();
      evt.stopPropagation();
      if (evt.key === "ArrowLeft") {
        if (depth > 0) {
          const trigger = levels[depth]!.trigger;
          closeLevelsFrom(depth);
          trigger?.focus({ preventScroll: true });
        }
        return;
      }
      const at = depth < 0 ? 0 : depth;
      const rows = levelButtons(levels[at]);
      if (rows.length === 0) return;
      const index = rows.indexOf(document.activeElement as never);
      const step = evt.key === "ArrowDown" ? 1 : -1;
      const next =
        index < 0 ? (step > 0 ? 0 : rows.length - 1) : (index + step + rows.length) % rows.length;
      rows[next]!.focus({ preventScroll: true });
    }

    function buildLevel(
      records: readonly ContextMenuItem<Item>[],
      trigger: HTMLElement | null,
    ): Level {
      const depth = levels.length;
      const root = make("div", "dropdown-glass");
      root.dataset.level = String(depth);
      root.setAttribute("role", "menu");
      Object.assign(root.style, {
        position: "fixed",
        zIndex: "10000",
        minWidth: "8rem",
        maxWidth: "24rem",
        overflow: "hidden",
        borderRadius: "var(--radius-lg)",
        backgroundClip: "padding-box",
        color: "var(--contrast-popover-foreground)",
        outline: "none",
        pointerEvents: "auto",
      });
      const scroller = make("div");
      Object.assign(scroller.style, {
        maxHeight: "min(24rem, 70vh)",
        minWidth: "0",
        maxWidth: "24rem",
        overflowY: "auto",
        overflowX: "hidden",
        padding: "0.25rem",
      });
      scroller.addEventListener("mouseover", (evt) => {
        if (evt.target === scroller) closeLevelsFrom(depth + 1);
      });
      root.appendChild(scroller);

      let hasContent = false;
      for (const rec of records) {
        if (rec.separatorBefore && hasContent) {
          const sep = make("div");
          sep.dataset.contextMenuSeparator = "true";
          sep.setAttribute("role", "separator");
          Object.assign(sep.style, {
            height: "1px",
            margin: "0.25rem 0.5rem",
            background: "var(--contrast-border)",
          });
          scroller.appendChild(sep);
        }
        hasContent = true;
        scroller.appendChild(rec.header ? buildHeader(rec) : buildRow(rec, depth));
      }
      return { root: root, scroller, trigger };
    }

    function buildHeader(rec: ContextMenuItem<Item>): HTMLElement {
      const lineNo = make("div", "px-2 py-1.5 text-xs font-medium");
      lineNo.style.color = "var(--muted-foreground)";
      lineNo.textContent = rec.label;
      return lineNo;
    }

    function buildRow(rec: ContextMenuItem<Item>, depth: number): HTMLElement {
      const hasChildren = !!rec.children && rec.children.length > 0;
      const destructive = !hasChildren && (rec.destructive === true || rec.id === "delete");
      const disabled = rec.disabled === true;

      const btn = make("button", ROW_CLASS);
      btn.type = "button";
      btn.setAttribute("role", "menuitem");
      btn.disabled = disabled;
      btn.style.fontFamily = "var(--font-sans)";

      const icon = iconMarkup(rec.icon, `${ICON_SIZE} shrink-0`);
      if (icon) {
        const iconEl = make("span", "flex shrink-0");
        iconEl.innerHTML = icon;
        if (!destructive) iconEl.style.color = "var(--muted-foreground)";
        btn.appendChild(iconEl);
      }
      const caption = make("span", "min-w-0 flex-1 truncate");
      caption.textContent = rec.label;
      btn.appendChild(caption);

      if (hasChildren) {
        btn.setAttribute("aria-haspopup", "menu");
        btn.setAttribute("aria-expanded", "false");
        const chevron = make("span", "-me-0.5 ml-auto flex shrink-0");
        chevron.dataset.contextMenuChevron = "true";
        chevron.setAttribute("aria-hidden", "true");
        chevron.innerHTML = iconMarkup("chevron-right", ICON_SIZE);
        Object.assign(chevron.style, { color: "var(--muted-foreground)", opacity: "0.8" });
        btn.appendChild(chevron);
      }

      let hovered = false;
      let focused = false;
      const paint = () => {
        const lit = !disabled && (hovered || focused);
        const style = btn.style;
        const litBackground = destructive
          ? "color-mix(in srgb, var(--destructive) 10%, transparent)"
          : "var(--accent)";
        style.background = lit ? litBackground : "transparent";
        style.color = disabled
          ? "var(--contrast-muted-foreground)"
          : destructive
            ? "var(--destructive-foreground)"
            : lit
              ? "var(--contrast-accent-foreground)"
              : "var(--contrast-foreground)";
      };
      if (disabled) {
        Object.assign(btn.style, {
          opacity: "0.64",
          pointerEvents: "none",
          cursor: "not-allowed",
        });
      }
      paint();
      if (disabled) return btn;

      btn.addEventListener("focus", () => {
        focused = true;
        paint();
      });
      btn.addEventListener("blur", () => {
        focused = false;
        paint();
      });
      btn.addEventListener("mouseenter", () => {
        hovered = true;
        paint();
        btn.focus({ preventScroll: true });
        if (hasChildren) openSubmenu(false);
        else closeLevelsFrom(depth + 1);
      });
      btn.addEventListener("mouseleave", () => {
        hovered = false;
        paint();
      });

      function openSubmenu(focusFirst: boolean) {
        const existing = levels[depth + 1];
        if (!existing || existing.trigger !== btn) {
          closeLevelsFrom(depth + 1);
          const kid = buildLevel(rec.children!, btn);
          levels.push(kid);
          document.body.appendChild(kid.root);
          btn.setAttribute("aria-expanded", "true");
          placeSubmenu(kid.root, btn);
        }
        if (focusFirst) {
          const head = Array.from(
            levels[depth + 1]?.scroller.querySelectorAll("button") ?? [],
          ).find((second) => !second.disabled);
          head?.focus({ preventScroll: true });
        }
      }

      btn.addEventListener("click", () => {
        if (hasChildren) {
          openSubmenu(true);
          return;
        }
        if (!armed) return;
        finish(rec.id);
      });
      return btn;
    }

    function placeSubmenu(menu: HTMLElement, trigger: HTMLElement) {
      const tt = trigger.getBoundingClientRect();
      menu.style.left = `${tt.right + SUBMENU_GAP}px`;
      menu.style.top = `${tt.top}px`;
      const box = menu.getBoundingClientRect();
      let leftSide = tt.right + SUBMENU_GAP;
      if (box.right > window.innerWidth) leftSide = tt.left - box.width - SUBMENU_GAP;
      leftSide = clamp(leftSide, EDGE_MARGIN, window.innerWidth - box.width - EDGE_MARGIN);
      const upper = clamp(tt.top, EDGE_MARGIN, window.innerHeight - box.height - EDGE_MARGIN);
      menu.style.left = `${leftSide}px`;
      menu.style.top = `${upper}px`;
    }

    activeSession = sess;
    const head = buildLevel(elems, null);
    levels.push(head);
    head.root.style.left = `${place.x}px`;
    head.root.style.top = `${place.y}px`;
    document.body.appendChild(head.root);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", onKeyDown, true);

    // One frame later: keep the menu inside the viewport and start honouring pointer input,
    // so the gesture that opened it cannot also dismiss or select.
    requestAnimationFrame(() => {
      if (finished) return;
      const box = head.root.getBoundingClientRect();
      head.root.style.left = `${clamp(place.x, EDGE_MARGIN, window.innerWidth - box.width - EDGE_MARGIN)}px`;
      head.root.style.top = `${clamp(place.y, EDGE_MARGIN, window.innerHeight - box.height - EDGE_MARGIN)}px`;
      armed = true;
    });
  });
}
