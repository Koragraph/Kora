import type { AgentProfileId, HostThreadRef, ThreadId } from "@kora/contracts";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  type TerminalOutputCursor,
  type TerminalOutputUpdate,
  type PtySessionState,
} from "@kora/client-runtime/store/terminal";
import {
  isAtomActionInterrupted,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
} from "../appearance/appearanceFonts";
import { useAtomAction } from "../atoms/use-atom-command";
import { primaryDaemonAvailableEditorsAtom } from "../atoms/server";
import { webHost } from "../atoms/preview";
import { terminalHost } from "../atoms/terminal";
import { useAttachedTerminalSession } from "../atoms/terminalSessions";
import { threadToast, toastManager } from "../components/ui/toast";
import { openTerminalLinkInWeb } from "../components/web/openTerminalLinkInWeb";
import { readTextFromClipboard, writeTextToClipboard } from "../hooks/useCopyText";
import { useClientPrefs } from "../hooks/usePrefs";
import { readLocalApi } from "../localApi";
import { isTerminalUrl, resolvePathLinkTarget } from "../thread/terminal-links";
import { observeSelectionActions, resolveSelectionActionPosition } from "../util/selectionActions";
import {
  normalizeTerminalExcerptText,
  type TerminalExcerptSelection,
} from "../util/terminalContext";
import { useOpenInEditor } from "../workspace/editorPreferences";
import { terminalDeleteInputData, terminalNavigationInputData } from "./keyInput";
import {
  shouldClearTerminalSelectionAction,
  shouldHandleTerminalExit,
  terminalContextMenuItems,
  terminalSelectionLineRange,
  terminalSelectionMenuItems,
} from "./selection";
import { terminalThemeFromApp } from "./theme";
import { TerminalSurface, type TerminalFont } from "./xtermSurface";

export function writeTerminalOutputUpdate(
  target: Pick<TerminalSurface, "write" | "resetAndWrite">,
  update: TerminalOutputUpdate,
): void {
  switch (update.type) {
    case "reset":
      target.resetAndWrite(update.data);
      return;
    case "append":
      target.write(update.data);
      return;
    default:
      return;
  }
}

export interface TerminalViewportProps {
  threadRef: HostThreadRef;
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  providerInstanceId?: AgentProfileId;
  advancedTypography: boolean;
  visible: boolean;
  autoFocus: boolean;
  focusRequestId: number;
  /** Bumped by the owner whenever the space available to the terminal may have changed. */
  drawerHeight: number;
  resizeEpoch: number;
  onSessionExited: () => void;
  onAddTerminalContext?: (selection: TerminalExcerptSelection) => void;
}

const message = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/** Order-independent identity of an env map, so a re-created but equal object does not reattach the session. */
function envKeyOf(env: Record<string, string> | undefined): string {
  if (!env) return "";
  const pairs = Object.keys(env)
    .filter((key) => key !== "" && typeof env[key] === "string")
    .sort()
    .map((key) => [key, env[key]]);
  return JSON.stringify(pairs);
}

function useTerminalFont(advanced: boolean): TerminalFont {
  const prefs = useClientPrefs(
    (p: {
      fontFamilyCode: string;
      fontSizeCode: number;
      fontFamilyTerminal: string;
      fontSizeTerminal: number;
    }) => p,
  );
  return useMemo(() => {
    const family = resolveTerminalFontPreference({
      advanced,
      code: prefs.fontFamilyCode,
      terminal: prefs.fontFamilyTerminal,
    }).trim();
    const size = resolveTerminalFontSizePreference({
      advanced,
      code: prefs.fontSizeCode,
      terminal: prefs.fontSizeTerminal,
    });
    return family ? { family, size } : { size };
  }, [advanced, prefs]);
}

/** Everything the mounted terminal reads at event time; refreshed on every render. */
interface Live {
  props: TerminalViewportProps;
  session: PtySessionState & { output: unknown; version: unknown; error: string | null };
  font: TerminalFont;
  write: (data: string, failure: string) => void;
  resize: (cols: number, rows: number) => void;
  openPreview: unknown;
  openInEditor: ReturnType<typeof useOpenInEditor>;
}

interface Connection {
  readonly ready: Promise<TerminalSurface | null>;
  sync(): void;
  dispose(): void;
}

/**
 * Builds the surface for one session and wires it to the daemon: output replay, input, resize, the selection popup,
 * the right-click menu, links, theme changes. Returns a handle the component drives.
 */
function connectTerminal(mount: HTMLElement, live: { current: Live }): Connection {
  let surface: TerminalSurface | null = null;
  let disposed = false;
  let cursor: TerminalOutputCursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
  let seen = {
    output: live.current.session.output,
    version: live.current.session.version,
    error: live.current.session.error,
  };
  let lastStatus: PtySessionState["status"] = "closed";
  let exitHandled = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const teardown: Array<() => void> = [];

  // Menu bookkeeping: each popup/menu takes a ticket; only the newest ticket may act or close things.
  const menu = { ticket: 0, pending: false, openTicket: null as number | null };
  const retireMenu = (closeNative: boolean) => {
    menu.ticket += 1;
    menu.pending = false;
    menu.openTicket = null;
    if (closeNative) void readLocalApi()?.contextMenu.close();
  };

  const note = (text: string) => surface?.write(`\r\n[terminal] ${text}\r\n`);
  const selection = () => normalizeTerminalExcerptText(surface?.getSelection() ?? "");
  const refocus = () => surface?.focus();

  const trackStatus = () => {
    const status = live.current.session.status;
    if (status === "running") exitHandled = false;
    if (shouldHandleTerminalExit(status, lastStatus, exitHandled)) {
      exitHandled = true;
      note(status === "closed" ? "Terminal closed" : "Process exited");
      timers.push(setTimeout(() => exitHandled && live.current.props.onSessionExited(), 0));
    }
    lastStatus = status;
  };

  const sync = () => {
    if (!surface) return;
    trackStatus();
    const { output, version, error } = live.current.session;
    if (output === seen.output && version === seen.version) return;
    seen = { ...seen, output, version };
    const update = readTerminalOutputUpdate(output as never, cursor);
    writeTerminalOutputUpdate(surface, update);
    cursor = update.cursor;
    if (update.type !== "none") surface.clearSelection();
    if (error !== seen.error) {
      seen = { ...seen, error };
      if (error) note(error);
    }
  };

  const addToChat = (text: string, range: { lineStart: number; lineEnd: number }) => {
    const { props } = live.current;
    props.onAddTerminalContext?.({
      terminalId: props.terminalId,
      terminalLabel: props.terminalLabel,
      text,
      ...range,
    });
    surface?.clearSelection();
  };

  const copy = async (text: string) => {
    try {
      await writeTextToClipboard(text, "terminal selection");
    } catch (cause) {
      note(message(cause, "Unable to copy terminal selection"));
    }
  };

  const canAddToChat = () => Boolean(live.current.props.onAddTerminalContext);

  const selectionPopup = async (pointer: { x: number; y: number } | null) => {
    const api = readLocalApi();
    const target = surface;
    if (!api || !target?.hasSelection()) return;
    const text = selection();
    const position = target.getSelectionPosition();
    if (!text || !position) return;
    const ticket = ++menu.ticket;
    menu.pending = true;
    menu.openTicket = ticket;
    const anchor = resolveSelectionActionPosition({
      bounds: mount.getBoundingClientRect(),
      selectionRect: target.getSelectionEndClientRect(),
      pointer,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    const choice = await api.contextMenu
      .show(terminalSelectionMenuItems({ canAddToChat: canAddToChat() }), anchor)
      .catch(() => null);
    if (ticket !== menu.ticket) return;
    menu.pending = false;
    menu.openTicket = null;
    if (choice === "add-to-chat") addToChat(text, terminalSelectionLineRange(position));
    if (choice === "copy") await copy(text);
    if (ticket === menu.ticket) refocus();
  };

  const rightClick = async (event: MouseEvent) => {
    event.preventDefault();
    const api = readLocalApi();
    const target = surface;
    if (!api || !target) return;
    const ticket = ++menu.ticket;
    menu.openTicket = null;
    const text = selection();
    const position = target.getSelectionPosition();
    let choice;
    try {
      choice = await api.contextMenu.show(
        terminalContextMenuItems({
          hasSelection: target.hasSelection(),
          canAddToChat: canAddToChat(),
        }),
        { x: event.clientX, y: event.clientY },
      );
    } catch (cause) {
      note(message(cause, "Unable to open the terminal context menu"));
      return;
    }
    if (ticket !== menu.ticket || !choice) return;
    if (choice === "paste") {
      await target
        .pasteFromClipboard(
          () => readTextFromClipboard("terminal input"),
          () => ticket === menu.ticket,
        )
        .catch((cause: unknown) => note(message(cause, "Unable to read the clipboard")));
    } else if (choice === "copy" && text) {
      await copy(text);
    } else if (choice === "add-to-chat" && text && position) {
      addToChat(text, terminalSelectionLineRange(position));
    }
    if (ticket === menu.ticket) refocus();
  };

  const openLink = (text: string, event: MouseEvent) => {
    const { props, openPreview, openInEditor } = live.current;
    if (!isTerminalUrl(text)) {
      void openInEditor(resolvePathLinkTarget(text, props.cwd)).then((result) => {
        if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
          note(message(squashAtomActionFailure(result), "Unable to open path"));
        }
      });
      return;
    }
    const api = readLocalApi();
    if (!api) {
      note("Opening links is unavailable in this browser.");
      return;
    }
    openTerminalLinkInWeb({
      url: text,
      threadRef: props.threadRef,
      openPreview: openPreview as never,
      forceBrowser: event.metaKey || event.ctrlKey,
      fallbackToBrowser: () => {
        api.shell
          .openExternal(text)
          .catch((cause: unknown) => note(message(cause, "Unable to open link")));
      },
    }).catch((cause: unknown) => {
      toastManager.add(
        threadToast({
          type: "error",
          title: "Unable to open link",
          description: message(cause, "An error occurred."),
        }),
      );
    });
  };

  const typedKey = (event: KeyboardEvent): boolean => {
    const navigation = terminalNavigationInputData(event);
    const data = navigation ?? terminalDeleteInputData(event);
    if (data === null) return true;
    event.preventDefault();
    event.stopPropagation();
    live.current.write(
      data,
      navigation === null ? "Failed to delete terminal input" : "Failed to move cursor",
    );
    return false;
  };

  const selectionChanged = () => {
    if (!surface) return;
    if (surface.hasSelection()) {
      popups?.selectionChanged();
      return;
    }
    const owning = shouldClearTerminalSelectionAction({
      actionPending: menu.pending,
      openMenuRequestId: menu.openTicket,
      currentRequestId: menu.ticket,
    });
    if (owning) retireMenu(true);
  };

  let popups: ReturnType<typeof observeSelectionActions> | undefined;
  const fontAtStart = live.current.font;

  const ready = TerminalSurface.create(mount, {
    theme: terminalThemeFromApp(mount),
    font: fontAtStart,
    visible: live.current.props.visible,
    onData: (data) => live.current.write(data, "Terminal write failed"),
    onResize: (cols, rows) => live.current.resize(cols, rows),
    onSelectionChange: selectionChanged,
    beforeKey: typedKey,
    onLinkActivate: openLink,
    onContextMenu: (event) => void rightClick(event),
  }).then(
    (created) => {
      if (disposed) {
        created.dispose();
        return null;
      }
      surface = created;
      created.setVisible(live.current.props.visible);

      const first = readTerminalOutputUpdate(live.current.session.output as never, cursor);
      if (first.type === "reset" && first.data) created.resetAndWrite(first.data);
      cursor = first.cursor;
      seen = {
        output: live.current.session.output,
        version: live.current.session.version,
        error: live.current.session.error,
      };
      if (seen.error) note(seen.error);
      trackStatus();
      if (live.current.font !== fontAtStart) void created.setFont(live.current.font);

      popups = observeSelectionActions({
        element: mount,
        onSelection: (pointer) => void selectionPopup(pointer),
        onDismiss: (reason) => {
          if (reason === "interaction") retireMenu(false);
          else if (menu.openTicket !== null && menu.openTicket === menu.ticket) retireMenu(true);
        },
      });
      teardown.push(() => popups?.dispose());

      const recolor = new MutationObserver(() => created.setTheme(terminalThemeFromApp(mount)));
      recolor.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      teardown.push(() => recolor.disconnect());

      timers.push(
        setTimeout(() => {
          const stick = created.isAtBottom();
          created.fit();
          if (stick) created.scrollToBottom();
        }, 30),
      );
      return created;
    },
    (cause: unknown) => {
      if (!disposed)
        mount.textContent = `${message(cause, "Unable to start the terminal")} — close and reopen it to retry.`;
      return null;
    },
  );

  return {
    ready,
    sync,
    dispose() {
      disposed = true;
      exitHandled = false;
      timers.forEach(clearTimeout);
      teardown.splice(0).forEach((fn) => fn());
      surface?.dispose();
      surface = null;
    },
  };
}

export function TerminalViewport(props: TerminalViewportProps) {
  const { threadRef, threadId, terminalId, cwd, worktreePath, runtimeEnv, providerInstanceId } =
    props;
  const hostId = threadRef.hostId;
  const mountRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<TerminalSurface | null>(null);
  const [generation, setGeneration] = useState(0);
  const font = useTerminalFont(props.advancedTypography);

  const envKey = envKeyOf(runtimeEnv);
  const attach = useMemo(
    () => ({
      threadId,
      terminalId,
      cwd,
      ...(worktreePath ? { worktreePath } : {}),
      ...(envKey ? { env: runtimeEnv } : {}),
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),
    // runtimeEnv is compared through envKey
    [threadId, terminalId, cwd, worktreePath, envKey, providerInstanceId],
  );
  const session = useAttachedTerminalSession({ hostId, terminal: attach as never });

  const writeInput = useAtomAction(terminalHost.write, { reportFailure: false });
  const resizePty = useAtomAction(terminalHost.resize, { reportFailure: false });
  const openPreview = useAtomAction(webHost.open, { reportFailure: false });
  const openInEditor = useOpenInEditor(hostId, useAtomValue(primaryDaemonAvailableEditorsAtom));

  const live = useRef<Live>(null as never);
  live.current = {
    props,
    session: session as Live["session"],
    font,
    openPreview,
    openInEditor,
    write: (data, failure) => {
      void writeInput({ hostId, input: { threadId, terminalId, data } } as never).then((result) => {
        if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
          surfaceRef.current?.write(
            `\r\n[terminal] ${message(squashAtomActionFailure(result), failure)}\r\n`,
          );
        }
      });
    },
    resize: (cols, rows) =>
      void resizePty({ hostId, input: { threadId, terminalId, cols, rows } } as never),
  };

  const connection = useRef<Connection | null>(null);
  useEffect(() => {
    connection.current?.sync();
  }, [session.output, session.error, session.status, session.version]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const hadFocus = mount.contains(document.activeElement);
    const conn = connectTerminal(mount, live);
    let current = true;
    void conn.ready.then((surface) => {
      if (!current || !surface) return;
      surfaceRef.current = surface;
      connection.current = conn;
      if (hadFocus && live.current.props.visible) surface.focus();
      setGeneration((n) => n + 1);
    });
    return () => {
      current = false;
      const refocusMount = hadFocus || mount.contains(document.activeElement);
      connection.current = null;
      surfaceRef.current = null;
      conn.dispose();
      if (refocusMount) mount.focus();
    };
    // A new surface only for a new session identity; everything else is read through `live`.
  }, [cwd, hostId, envKey, terminalId, threadId, worktreePath]);

  useEffect(() => {
    void surfaceRef.current?.setFont(font);
  }, [font]);

  useEffect(() => {
    surfaceRef.current?.setVisible(props.visible);
  }, [props.visible, generation]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!props.visible || !surface) return;
    const stick = surface.isAtBottom();
    const frame = requestAnimationFrame(() => {
      surface.fit();
      if (stick) surface.scrollToBottom();
    });
    return () => cancelAnimationFrame(frame);
  }, [
    props.drawerHeight,
    props.resizeEpoch,
    props.visible,
    hostId,
    terminalId,
    threadId,
    generation,
  ]);

  useEffect(() => {
    if (!props.autoFocus || !props.visible) return;
    if (surfaceRef.current) surfaceRef.current.focus();
    else mountRef.current?.focus();
  }, [props.autoFocus, props.visible, props.focusRequestId, generation]);

  return (
    <div
      ref={mountRef}
      tabIndex={-1}
      className="relative h-full w-full overflow-hidden px-1.5 pt-1 outline-none"
      style={{ background: "var(--terminal-background)" }}
    />
  );
}
