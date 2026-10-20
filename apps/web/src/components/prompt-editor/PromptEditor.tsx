/**
 * The composer's text editor: a controlled Lexical plain-text editor whose value is the prompt string, with files,
 * skills, citations and context references shown as chips. See ./offsets.ts for how positions are counted.
 */
import type { AgentSkill, ContextChipClipboardFragment } from "@kora/contracts";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { type InitialConfigType, LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  HISTORY_PUSH_TAG,
  SKIP_DOM_SELECTION_TAG,
  type EditorState,
  type NodeKey,
} from "lexical";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEventHandler,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import {
  clampCollapsedPromptCursor,
  collapseExpandedPromptCursor,
  expandCollapsedPromptCursor,
  isCollapsedCursorAdjacentToInlineToken,
} from "~/prompt-logic";
import { collectInlineContextIds } from "~/util/contextChipReferences";
import { cn } from "~/util/utils";
import {
  ContextChipRecordsContext,
  type PromptDraftContextRecords,
} from "../contextChipPresentation";
import { didPromptSelectionChangeVisibly } from "../promptSelection";
import { getTranscriptPageScrollKey } from "../thread/pageScrollController";
import { isCaretOnVisualEdge } from "./caretLine";
import { FileChipNode, PromptSkillsContext, SkillChipNode, skillChipDetails } from "./chips";
import {
  $takeCitationCommentRequest,
  CitationChipNode,
  CitationCommentContext,
  type CitationCommentRequest,
  type CitationCommentTarget,
} from "./citationChip";
import {
  registerChipCopy,
  registerChipPaste,
  type BuildContextFragment,
  type ImportContextFragment,
} from "./clipboard";
import { ContextRefChipNode } from "./contextRefChip";
import { registerChipSelectionHighlight } from "./highlight";
import {
  registerCaretOffChips,
  registerChipBackspace,
  registerChipStepping,
  registerCommandKeys,
  registerMacLineEnds,
  type CommandKeyHandler,
} from "./keyboard";
import { $caretOffset, $selectRange, $writePrompt, contextIdsIn, expandedRangeOf } from "./offsets";
import { registerSurroundSelection } from "./surround";
import { unregisterAll } from "./unregister";

export type { PromptCommandKey } from "./keyboard";

/** What the editor holds: the prompt, the caret in both measures, and the context ids its chips reference. */
export type PromptSnapshot = {
  value: string;
  contextIds: string[];
  /** Collapsed and expanded caret offsets (see ./offsets.ts). */
  cursor: number;
  expandedCursor: number;
};

export interface PromptEditorHandle {
  /** The editor's current content and caret (read from the editor, not from the last render). */
  readSnapshot: () => PromptSnapshot;
  /** The selection as expanded offsets (a caret is start === end). */
  readSelectionRange: () => { start: number; end: number };
  /** True when a collapsed caret is on the first ("start") or last ("end") visual line, soft wraps counted. */
  isCaretOnVisualEdge: (edge: "start" | "end") => boolean;
  /** Opens the comment box of the citation a "Cite" action is about to put into the prompt. */
  requestCitationComment: (request: CitationCommentRequest) => void;
  /** Focus with the caret at a collapsed offset, at the end, or where it last was. */
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  focus: () => void;
}

interface PromptEditorProps {
  value: string;
  /** Collapsed caret offset (a chip counts as one). */
  cursor: number;
  disabled: boolean;
  placeholder: string;
  skills: ReadonlyArray<AgentSkill>;
  /** Draft records behind the prompt's context chips, by context id. */
  contextRecords: PromptDraftContextRecords;
  editorRef: RefObject<PromptEditorHandle | null>;
  onChange: (
    value: string,
    cursor: number,
    expandedCursor: number,
    caretBesideChip: boolean,
    contextIds: string[],
  ) => void;
  onPaste: ClipboardEventHandler<HTMLElement>;
  onCommandKeyDown?: CommandKeyHandler;
  /** The selection moved without the prompt or caret changing (so a selection toolbar can follow). */
  onVisibleSelectionChange?: () => void;
  /** Page keys scroll the transcript; these hand them over and take them back. */
  onPageScrollRelease?: () => void;
  onPageScrollKeyDown?: (key: "PageUp" | "PageDown") => void;
  onPageScrollKeyUp?: (key: string) => void;
  importContextFragment?: ImportContextFragment | undefined;
  buildContextClipboardFragment?: BuildContextFragment | undefined;
  className?: string;
  containerClassName?: string;
  placeholderClassName?: string;
}

// A fresh key per module load, so a hot reload remounts the composer instead of keeping a stale editor.
const RELOAD_KEY = `prompt-editor-${Math.random().toString(36).slice(2)}`;

/** A string that changes whenever anything a skill chip shows changes. */
const skillsKey = (skills: ReadonlyArray<AgentSkill>) =>
  JSON.stringify(
    skills.map((s) => [
      s.name,
      s.displayName,
      s.shortDescription,
      s.description,
      s.path,
      s.scope,
      s.enabled,
    ]),
  );

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** Registers the editor's own key, clipboard and selection behaviour (everything beyond plain text). */
function EditorBehaviour(props: {
  commandKeys: () => CommandKeyHandler | undefined;
  skills: () => ReturnType<typeof skillChipDetails>;
  importContextFragment: ImportContextFragment | undefined;
  buildContextClipboardFragment: BuildContextFragment | undefined;
}) {
  const [editor] = useLexicalComposerContext();
  const { commandKeys, skills, importContextFragment, buildContextClipboardFragment } = props;
  useEffect(
    () =>
      unregisterAll(
        registerCommandKeys(editor, commandKeys),
        registerSurroundSelection(editor, skills),
        registerMacLineEnds(editor),
        registerChipStepping(editor),
        registerCaretOffChips(editor),
        registerChipBackspace(editor),
        registerChipSelectionHighlight(editor),
      ),
    [editor, commandKeys, skills],
  );
  useEffect(
    () => registerChipPaste(editor, importContextFragment),
    [editor, importContextFragment],
  );
  useEffect(
    () =>
      buildContextClipboardFragment
        ? registerChipCopy(editor, buildContextClipboardFragment)
        : undefined,
    [editor, buildContextClipboardFragment],
  );
  return null;
}

function ControlledEditor(props: PromptEditorProps) {
  const { value, cursor, skills, disabled, editorRef } = props;
  const [editor] = useLexicalComposerContext();

  // Latest props for listeners registered once.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const skillDetails = useRef(skillChipDetails(skills));
  useLayoutEffect(() => {
    skillDetails.current = skillChipDetails(skills);
  }, [skills]);
  const commandKeys = useCallback(() => latest.current.onCommandKeyDown, []);
  const currentSkills = useCallback(() => skillDetails.current, []);

  // What the editor last reported (or was last given), and the selection range that goes with it.
  const startCursor = clampCollapsedPromptCursor(value, cursor);
  const startExpanded = expandCollapsedPromptCursor(value, startCursor);
  const shown = useRef<PromptSnapshot>({
    value,
    cursor: startCursor,
    expandedCursor: startExpanded,
    contextIds: collectInlineContextIds(value),
  });
  const range = useRef({ start: startExpanded, end: startExpanded });
  const shownSkills = useRef(skillsKey(skills));
  /** Set while a controlled value is being written, so the change it causes is not reported back. */
  const writing = useRef(false);

  const citeRequest = useRef<CitationCommentRequest | null>(null);
  const [openComment, setOpenComment] = useState<CitationCommentTarget | null>(null);
  const comments = useMemo(
    () => ({
      openComment,
      onOpenChange: (nodeKey: NodeKey, open: boolean) =>
        setOpenComment((now) => (open ? { nodeKey } : now?.nodeKey === nodeKey ? null : now)),
    }),
    [openComment],
  );

  useEffect(() => editor.setEditable(!disabled), [editor, disabled]);

  // A comment box closes when its citation leaves the prompt.
  useEffect(() => {
    const key = openComment?.nodeKey;
    if (!key) return;
    return editor.registerUpdateListener(({ editorState }) => {
      const present = editorState.read(() => {
        const node = $getNodeByKey(key);
        return node instanceof CitationChipNode && node.isAttached();
      });
      if (!present) setOpenComment((now) => (now?.nodeKey === key ? null : now));
    });
  }, [editor, openComment?.nodeKey]);

  /** Reads the editor's prompt, caret and selection (falling back to the last known caret when there is none). */
  const $read = (): PromptSnapshot & { selection: { start: number; end: number } } => {
    const text = $getRoot().getTextContent();
    const caret = clampCollapsedPromptCursor(
      text,
      $caretOffset("collapsed", clampCollapsedPromptCursor(text, shown.current.cursor)),
    );
    const clampExpanded = (n: number) =>
      Number.isFinite(n) ? Math.max(0, Math.min(text.length, Math.floor(n))) : text.length;
    const expandedCaret = clampExpanded(
      $caretOffset("expanded", clampExpanded(shown.current.expandedCursor)),
    );
    return {
      value: text,
      cursor: caret,
      expandedCursor: expandedCaret,
      contextIds: contextIdsIn($getRoot()),
      selection: expandedRangeOf($getSelection()) ?? { start: expandedCaret, end: expandedCaret },
    };
  };

  // Props -> editor: write a new value (or new skills) into the editor, and place the caret.
  useLayoutEffect(() => {
    const caret = clampCollapsedPromptCursor(value, cursor);
    const before = shown.current;
    const skillsChanged = shownSkills.current !== skillsKey(skills);
    if (before.value === value && before.cursor === caret && !skillsChanged) return;
    const expanded = expandCollapsedPromptCursor(value, caret);
    shown.current = {
      value,
      cursor: caret,
      expandedCursor: expanded,
      contextIds: collectInlineContextIds(value),
    };
    shownSkills.current = skillsKey(skills);
    range.current = { start: expanded, end: expanded };

    const rewrite = before.value !== value || skillsChanged;
    const focused =
      document.activeElement !== null && editor.getRootElement() === document.activeElement;
    // A caret move alone matters only while the user is in the editor.
    if (!rewrite && !focused) return;

    writing.current = true;
    const fromCite = citeRequest.current?.value === value;
    let toOpen: CitationCommentTarget | null = null;
    editor.update(
      () => {
        if (rewrite) $writePrompt(value, skillDetails.current);
        $selectRange(caret);
        toOpen = $takeCitationCommentRequest(citeRequest);
      },
      {
        // A cite is its own undo step, and must not move the page's selection into the editor.
        ...(fromCite ? { tag: [HISTORY_PUSH_TAG, SKIP_DOM_SELECTION_TAG] } : {}),
        onUpdate: () => {
          if (toOpen) setOpenComment(toOpen);
        },
      },
    );
    queueMicrotask(() => {
      writing.current = false;
    });
  }, [editor, value, cursor, skills]);

  /** Editor -> props: report a changed prompt, caret or chip set. */
  const onEditorChange = useCallback((state: EditorState) => {
    state.read(() => {
      const now = $read();
      const previousRange = range.current;
      range.current = now.selection;
      const before = shown.current;
      const changed =
        before.value !== now.value ||
        before.cursor !== now.cursor ||
        before.expandedCursor !== now.expandedCursor ||
        !sameIds(before.contextIds, now.contextIds);
      if (writing.current) return;
      if (!changed) {
        if (didPromptSelectionChangeVisibly(previousRange, now.selection))
          latest.current.onVisibleSelectionChange?.();
        return;
      }
      // A caret-only update while a newer prompt waits to be written (a chip just added through the store) would
      // report old text and old ids and undo that change. Let the write land first.
      if (before.value === now.value && now.value !== latest.current.value) return;
      const { selection: _, ...snapshot } = now;
      shown.current = snapshot;
      const besideChip =
        isCollapsedCursorAdjacentToInlineToken(now.value, now.cursor, "left") ||
        isCollapsedCursorAdjacentToInlineToken(now.value, now.cursor, "right");
      latest.current.onChange(
        now.value,
        now.cursor,
        now.expandedCursor,
        besideChip,
        now.contextIds,
      );
    });
    // $read only touches refs that are stable for the editor's life.
  }, []);

  const readSnapshot = useCallback((): PromptSnapshot => {
    const { selection, ...snapshot } = editor.getEditorState().read($read);
    range.current = selection;
    shown.current = snapshot;
    return snapshot;
  }, [editor]);

  const focusAt = useCallback(
    (target: number) => {
      const root = editor.getRootElement();
      if (!root) return;
      root.focus({ preventScroll: true });
      // A newer prompt is about to be written (a chip just went in through the store): reporting the editor's old
      // text now would overwrite it. That write places the caret from the store instead.
      if (shown.current.value !== latest.current.value) return;
      const caret = clampCollapsedPromptCursor(shown.current.value, target);
      editor.update(() => $selectRange(caret));
      if (caret === shown.current.cursor) return;
      const expandedCursor = expandCollapsedPromptCursor(shown.current.value, caret);
      shown.current = { ...shown.current, cursor: caret, expandedCursor };
      range.current = { start: expandedCursor, end: expandedCursor };
      const { value: text, contextIds } = shown.current;
      latest.current.onChange(text, caret, expandedCursor, false, contextIds);
    },
    [editor],
  );

  useImperativeHandle(
    editorRef,
    () => ({
      readSnapshot,
      readSelectionRange: () => {
        readSnapshot();
        return range.current;
      },
      isCaretOnVisualEdge: (edge) => {
        const { value: text, expandedCursor } = readSnapshot();
        return isCaretOnVisualEdge(editor.getRootElement(), text, expandedCursor, edge);
      },
      requestCitationComment: (request) => {
        citeRequest.current = request;
        const target = editor.getEditorState().read(() => $takeCitationCommentRequest(citeRequest));
        if (target) setOpenComment(target);
      },
      focus: () => focusAt(shown.current.cursor),
      focusAt,
      focusAtEnd: () =>
        focusAt(collapseExpandedPromptCursor(shown.current.value, shown.current.value.length)),
    }),
    [editor, focusAt, readSnapshot],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const { onPageScrollKeyDown, onPageScrollRelease } = props;
    if (
      event.key === "Shift" ||
      event.key === "Alt" ||
      event.key === "Meta" ||
      event.key === "Control"
    ) {
      onPageScrollRelease?.();
    }
    if (event.key !== "PageUp" && event.key !== "PageDown") return;
    const box = event.currentTarget;
    const pageKey = getTranscriptPageScrollKey({
      key: event.key,
      keyCode: event.keyCode,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      defaultPrevented: event.defaultPrevented,
      scrollTop: box.scrollTop,
      scrollHeight: box.scrollHeight,
      clientHeight: box.clientHeight,
    });
    // Page keys scroll the transcript unless the editor itself has something to scroll.
    if (!pageKey) {
      onPageScrollRelease?.();
      return;
    }
    if (!onPageScrollKeyDown) return;
    event.preventDefault();
    onPageScrollKeyDown(pageKey);
  };

  return (
    <ContextChipRecordsContext value={props.contextRecords}>
      <CitationCommentContext value={comments}>
        <div
          className={cn(
            "relative [font-family:var(--font-composer,var(--font-sans))] [font-size:var(--font-size-prompt,0.875rem)] [@media(max-width:39.999rem)_and_(pointer:coarse)]:[font-size:max(var(--font-size-prompt,1rem),16px)]",
            props.containerClassName,
          )}
        >
          <PlainTextPlugin
            ErrorBoundary={LexicalErrorBoundary}
            contentEditable={
              <ContentEditable
                data-testid="composer-editor"
                aria-label="Message"
                aria-placeholder={props.placeholder}
                placeholder={<span />}
                // The wrapper carries the appearance preference; everything else is set here.
                className={cn(
                  "block max-h-50 min-h-7 w-full overflow-y-auto whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none",
                  props.className,
                )}
                onKeyDown={onKeyDown}
                onKeyUp={(event) => props.onPageScrollKeyUp?.(event.key)}
                onBlur={props.onPageScrollRelease}
                onPasteCapture={props.onPaste}
              />
            }
            placeholder={
              // Attached context reads as content: no placeholder over it.
              props.contextRecords.size > 0 ? null : (
                <div
                  className={cn(
                    "pointer-events-none absolute inset-0 leading-relaxed text-placeholder/75",
                    props.placeholderClassName,
                  )}
                >
                  {props.placeholder}
                </div>
              )
            }
          />
          <OnChangePlugin onChange={onEditorChange} />
          <EditorBehaviour
            commandKeys={commandKeys}
            skills={currentSkills}
            importContextFragment={props.importContextFragment}
            buildContextClipboardFragment={props.buildContextClipboardFragment}
          />
          <HistoryPlugin />
        </div>
      </CitationCommentContext>
    </ContextChipRecordsContext>
  );
}

export function PromptEditor(props: PromptEditorProps) {
  // The first value and skills seed the editor; later ones arrive through ControlledEditor.
  const seed = useRef({ value: props.value, skills: skillChipDetails(props.skills) });
  const config = useMemo<InitialConfigType>(
    () => ({
      namespace: "kora-prompt",
      editable: true,
      nodes: [FileChipNode, SkillChipNode, CitationChipNode, ContextRefChipNode],
      editorState: () => $writePrompt(seed.current.value, seed.current.skills),
      onError: (error) => {
        throw error;
      },
    }),
    [],
  );
  return (
    <PromptSkillsContext value={props.skills}>
      <LexicalComposer key={RELOAD_KEY} initialConfig={config}>
        <ControlledEditor {...props} />
      </LexicalComposer>
    </PromptSkillsContext>
  );
}
