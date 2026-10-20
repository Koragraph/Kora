import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { ILink, ITheme, Terminal } from "@xterm/xterm";

import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
} from "../thread/terminal-links";

/** Colours as CSS strings; xterm parses them itself. */
export type TerminalTheme = Pick<
  ITheme,
  "background" | "foreground" | "cursor" | "selectionBackground"
>;

export interface TerminalFont {
  readonly family?: string;
  readonly size: number;
}

export interface TerminalSurfaceOptions {
  readonly theme: TerminalTheme;
  readonly font: TerminalFont;
  readonly visible: boolean;
  readonly onData: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
  readonly onSelectionChange: () => void;
  /** Return false to swallow the key (the caller already handled it). */
  readonly beforeKey: (event: KeyboardEvent) => boolean;
  readonly onLinkActivate: (text: string, event: MouseEvent) => void;
  readonly onContextMenu: (event: MouseEvent) => void;
}

export interface TerminalSelectionPosition {
  /** 0-based buffer rows. */
  readonly start: { x: number; y: number };
  readonly end: { x: number; y: number };
}

/** xterm's bundles touch browser globals on import, so they load with the first terminal, never at module load. */
async function loadXterm() {
  const [core, fit, unicode, webgl] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-unicode11"),
    import("@xterm/addon-webgl"),
    import("@xterm/xterm/css/xterm.css"),
  ]);
  return {
    Terminal: core.Terminal,
    FitAddon: fit.FitAddon,
    Unicode11Addon: unicode.Unicode11Addon,
    WebglAddon: webgl.WebglAddon,
  };
}
type Xterm = Awaited<ReturnType<typeof loadXterm>>;

const FALLBACK_FAMILY =
  '"SF Mono", ui-monospace, Menlo, Monaco, "Cascadia Mono", Consolas, monospace';
const SCROLLBACK_LINES = 10_000;

/**
 * One terminal on screen: xterm.js with fit, unicode 11 widths, link detection for URLs and file paths, and the
 * WebGL renderer when the GPU allows it (the DOM renderer otherwise). The PTY lives in the daemon; this class only
 * renders bytes and reports input.
 */
export class TerminalSurface {
  static async create(
    mount: HTMLElement,
    options: TerminalSurfaceOptions,
  ): Promise<TerminalSurface> {
    const [xterm] = await Promise.all([loadXterm(), document.fonts?.ready.catch(() => undefined)]);
    return new TerminalSurface(xterm, mount, options);
  }

  private readonly term: Terminal;
  private readonly fitter: FitAddon;
  private webgl: WebglAddon | null = null;
  private readonly cleanups: Array<() => void> = [];
  private visible: boolean;
  private lastSize = "";
  private fitFrame = 0;

  private constructor(
    private readonly xterm: Xterm,
    private readonly mount: HTMLElement,
    private readonly options: TerminalSurfaceOptions,
  ) {
    this.visible = options.visible;
    this.fitter = new xterm.FitAddon();
    this.term = new xterm.Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      drawBoldTextInBrightColors: false,
      fontFamily: options.font.family || FALLBACK_FAMILY,
      fontSize: options.font.size,
      macOptionIsMeta: false,
      scrollback: SCROLLBACK_LINES,
      theme: options.theme,
    });
    this.term.loadAddon(this.fitter);
    this.term.loadAddon(new xterm.Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.open(mount);
    this.tryWebgl();

    const subs = [
      this.term.onData((data) => options.onData(data)),
      this.term.onResize(({ cols, rows }) => options.onResize(cols, rows)),
      this.term.onSelectionChange(() => options.onSelectionChange()),
      this.term.registerLinkProvider({ provideLinks: (row, done) => done(this.linksOnRow(row)) }),
    ];
    this.cleanups.push(() => subs.forEach((sub) => sub.dispose()));
    this.term.attachCustomKeyEventHandler(
      (event) => event.type !== "keydown" || options.beforeKey(event),
    );

    const onMenu = (event: MouseEvent) => options.onContextMenu(event);
    mount.addEventListener("contextmenu", onMenu);
    this.cleanups.push(() => mount.removeEventListener("contextmenu", onMenu));

    const observer = new ResizeObserver(() => this.scheduleFit());
    observer.observe(mount);
    this.cleanups.push(() => observer.disconnect());
    this.cleanups.push(() => cancelAnimationFrame(this.fitFrame));

    this.fit();
  }

  private tryWebgl(): void {
    try {
      const addon = new this.xterm.WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        this.webgl = null;
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      this.webgl = null; // no WebGL2: the DOM renderer stays
    }
  }

  private linksOnRow(row: number): ILink[] | undefined {
    const buffer = this.term.buffer.active;
    const logical = collectWrappedTerminalLinkLine(row, (index) => buffer.getLine(index));
    if (!logical) return undefined;
    const links: ILink[] = [];
    for (const match of extractTerminalLinks(logical.text)) {
      const from = this.cellAt(logical.segments, match.start);
      const to = this.cellAt(logical.segments, match.end - 1);
      if (!from || !to || from.y > row || to.y < row) continue;
      links.push({
        text: match.text,
        range: { start: from, end: to },
        decorations: { underline: true, pointerCursor: true },
        activate: (event, text) => {
          // URLs open on a plain click; paths need the platform modifier so a stray click never opens an editor.
          if (match.kind === "path" && !isTerminalLinkActivation(event)) return;
          this.options.onLinkActivate(text, event);
        },
      });
    }
    return links.length > 0 ? links : undefined;
  }

  /** Maps an offset in a logical (unwrapped) line to a 1-based buffer cell. */
  private cellAt(
    segments: ReadonlyArray<{ startIndex: number; endIndex: number; bufferLineNumber: number }>,
    offset: number,
  ): { x: number; y: number } | null {
    for (const seg of segments) {
      if (offset >= seg.startIndex && offset < seg.endIndex) {
        return { x: offset - seg.startIndex + 1, y: seg.bufferLineNumber };
      }
    }
    return null;
  }

  private scheduleFit(): void {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => {
      const stick = this.isAtBottom();
      this.fit();
      if (stick) this.scrollToBottom();
    });
  }

  write(data: string): void {
    this.term.write(data);
  }

  resetAndWrite(data: string): void {
    this.term.reset();
    if (data) this.term.write(data);
  }

  hasSelection(): boolean {
    return this.term.hasSelection();
  }

  getSelection(): string {
    return this.term.getSelection();
  }

  clearSelection(): void {
    this.term.clearSelection();
  }

  getSelectionPosition(): TerminalSelectionPosition | null {
    const range = this.term.getSelectionPosition();
    if (!range) return null;
    return {
      start: { x: range.start.x - 1, y: range.start.y - 1 },
      end: { x: range.end.x - 1, y: range.end.y - 1 },
    };
  }

  /** Screen rectangle of the last selected cell, for anchoring the selection popup. */
  getSelectionEndClientRect(): { left: number; top: number; right: number; bottom: number } | null {
    const range = this.term.getSelectionPosition();
    const screen = this.mount.querySelector(".xterm-screen");
    if (!range || !screen || this.term.cols === 0 || this.term.rows === 0) return null;
    const box = screen.getBoundingClientRect();
    const cellWidth = box.width / this.term.cols;
    const cellHeight = box.height / this.term.rows;
    const row = range.end.y - 1 - this.term.buffer.active.viewportY;
    if (row < 0 || row >= this.term.rows) return null;
    const left = box.left + (range.end.x - 1) * cellWidth;
    const top = box.top + row * cellHeight;
    return { left, top, right: left + cellWidth, bottom: top + cellHeight };
  }

  async pasteFromClipboard(read: () => Promise<string>, stillWanted: () => boolean): Promise<void> {
    const text = await read();
    if (text && stillWanted()) this.term.paste(text);
  }

  setTheme(theme: TerminalTheme): void {
    this.term.options.theme = theme;
  }

  async setFont(font: TerminalFont): Promise<void> {
    const family = font.family || FALLBACK_FAMILY;
    if (this.term.options.fontFamily === family && this.term.options.fontSize === font.size) return;
    this.term.options.fontFamily = family;
    this.term.options.fontSize = font.size;
    if (document.fonts?.load)
      await document.fonts.load(`${font.size}px ${family}`).catch(() => undefined);
    this.webgl?.clearTextureAtlas();
    this.scheduleFit();
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) {
      this.scheduleFit();
      this.term.refresh(0, this.term.rows - 1);
    }
  }

  fit(): void {
    const { width, height } = this.mount.getBoundingClientRect();
    if (!this.visible || width < 8 || height < 8) return;
    const proposed = this.fitter.proposeDimensions();
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
    const key = `${proposed.cols}x${proposed.rows}`;
    if (
      key === this.lastSize &&
      this.term.cols === proposed.cols &&
      this.term.rows === proposed.rows
    )
      return;
    this.lastSize = key;
    this.fitter.fit();
  }

  isAtBottom(): boolean {
    const buffer = this.term.buffer.active;
    return buffer.viewportY >= buffer.baseY;
  }

  scrollToBottom(): void {
    this.term.scrollToBottom();
  }

  focus(): void {
    this.term.focus();
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.webgl?.dispose();
    this.webgl = null;
    this.term.dispose();
  }
}
