// ---------------------------------------------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------------------------------------------

import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "./web/fileExplorerLabel";
import { TooltipTrigger, TooltipPopup, Tooltip } from "./ui/tooltip";
import { threadToast, toastManager } from "./ui/toast";
import { ScrollArea } from "./ui/scroll-area";
import { MenuTrigger, MenuPopup, MenuItem, Menu } from "./ui/menu";
import { CollapsibleTrigger, CollapsiblePanel, Collapsible } from "./ui/collapsible";
import { Button } from "./ui/button";
import { markdownImageGallery, markdownImageItems } from "./thread/markdownImageGallery";
import {
  showExternalLinkContextMenu,
  resolveExternalWebLinkHost,
} from "./thread/externalLinkContextMenu";
import { renderSkillInlineMarkdownChildren } from "./thread/SkillInlineText";
import { ReplyFootnoteChip } from "./thread/ReplyFootnoteChip";
import { FileEntryIcon } from "./thread/FileEntryIcon";
import { HighlightedCodeLines } from "./thread/HighlightedCodeLines";
import { CHAT_FILE_TAG_CHIP_CLASS_NAME, FileTagBody } from "./thread/FileTagChip";
import { resolveMarkdownMediaPreview, type ExpandedImageView } from "./thread/ExpandedImageView";
import { ExpandedImageDialog } from "./thread/ExpandedImageDialog";
import {
  isRemoteMediaApproved,
  approveRemoteMedia,
  remoteMediaHost,
} from "./media/remoteMediaConsent";
import { resolveProtocolRelativeMediaUrl } from "./media/mediaKinds";
import { MediaVideoPlayer } from "./media/VideoPlayer";
import { type MediaActionSource, MediaActions } from "./media/MediaMenu";
import { RenderErrorBoundary } from "./CrashBoundary";
import { GitHubIcon } from "./BrandIcons";
import {
  pickWorkspaceBasenameMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
  needsWorkspaceBasenameLookup,
  claimWorkspaceBasenameLookup,
} from "../workspace/workspaceBasenameLookup";
import { useOpenInEditor, useEditorPreference } from "../workspace/editorPreferences";
import { openInEditorMenuLabel } from "../workspace/editorLabels";
import {
  BrowserWebUnavailableError,
  BrowserPrefsReadError,
  openUrlInWeb,
} from "../webview/openFileInWeb";
import { canOpenLinksInApp, resolveLinkTarget } from "../webview/browserLinkTarget";
import { cn } from "../util/utils";
import { getSyntaxHighlighterPromise } from "../util/syntaxHighlighting";
import { LRUCache } from "../util/lruCache";
import { createIncrementalHighlightedDocument } from "../util/incrementalHighlighting";
import { resolveDiffThemeName, type DiffThemeName, fnv1a32 } from "../util/diffRendering";
import { rememberThreadVisit } from "../stores/webHistoryStore";
import { useDockStore } from "../stores/dockStore";
import { remarkNormalizeListItemIndentation } from "../markdown/list-indentation";
import {
  type MarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  shouldOpenMarkdownFileLinkInEditor,
  shouldOpenMarkdownFileLinkInBrowserByDefault,
  resolveMarkdownFileLinkMeta,
  normalizeMarkdownLinkDestination,
  isWindowsDrivePathHref,
  resolveInlineCodeFileLinkMeta,
  extractMarkdownLinkHrefs,
} from "../markdown/links";
import { createIncrementalMarkdownPlugin } from "../markdown/incremental";
import { remarkGithubAlerts } from "../markdown/github-alerts";
import {
  serializeTableElementToMarkdown,
  replyMarkdownClipboardPayload,
  serializeTableElementToCsv,
} from "../markdown/clipboard";
import { localApiOrThrow, readLocalApi } from "../localApi";
import { fileLinkOutsideFolder } from "../util/fileLinkScope";
import { useTheme } from "../hooks/useTheme";
import { useClientPrefs } from "../hooks/usePrefs";
import { useAtomQueryRunner } from "../atoms/use-atom-query-runner";
import { useAtomAction } from "../atoms/use-atom-command";
import { shellHost } from "../atoms/shell";
import { primaryDaemonAvailableEditorsAtom } from "../atoms/server";
import { projectHost } from "../atoms/projects";
import { webHost } from "../atoms/preview";
import { useDaemonConfigs } from "../atoms/entities";
import {
  hasSpecificFileIconForFileName,
  syntheticFileNameForLanguageId,
} from "../appearance/pierre-icons";
import { mediaKindFromPath } from "@kora/shared/fileViewer";
import { parseContextChipHref } from "@kora/shared/contextChipReferences";
import {
  encodeContextChipClipboardHtml,
  CONTEXT_CHIP_CLIPBOARD_MIME,
} from "@kora/shared/contextChipClipboard";
import { parseReplyFootnoteHref } from "@kora/shared/assistantFootnotes";
import type { HostThreadRef, AgentSkill, HostId } from "@kora/contracts";
import {
  isAtomActionInterrupted,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import {
  mediaFileReference,
  mediaUrlReference,
  type MediaReference,
} from "@kora/client-runtime/media/reference";
import { classifyMarkdownImageSource } from "@kora/client-runtime/markdown/images";
import {
  CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES,
  artifactTemplateFromHastProperties,
  renderCodexFileFootnotesAsMarkdown,
  remarkCodexDirectives,
} from "@kora/client-runtime/codex/markdown-directives";
import {
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
} from "@kora/client-runtime/codex/artifact-templates";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeRaw from "rehype-raw";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
} from "react-markdown";
import {
  type ComponentPropsWithoutRef,
  type ClipboardEvent,
  isValidElement,
  type CSSProperties,
  createContext,
  useCallback,
  type MouseEvent as ReactMouseEvent,
  useContext,
  type ReactNode,
  useEffect,
  Children,
  Suspense,
  useState,
  useMemo,
  useRef,
  memo,
  use,
} from "react";
import {
  LightbulbIcon,
  InfoIcon,
  TriangleAlertIcon,
  Globe2Icon,
  type LucideIcon,
  Maximize2Icon,
  ChevronRightIcon,
  OctagonAlertIcon,
  MessageSquareIcon,
  MailIcon,
  MessageSquareWarningIcon,
  PresentationIcon,
  WrapTextIcon,
  CheckIcon,
  CopyIcon,
  AlertTriangleIcon,
  ImageIcon,
  FileSpreadsheetIcon,
  Minimize2Icon,
  FileTextIcon,
} from "lucide-react";
import { toHtml } from "hast-util-to-html";
import { useAtomValue } from "@effect/atom-react";

export interface ReplyMarkdownContextReference {
  contextId: string;
  label: string;
  kind: string;
}

export function canUseMarkdownFileShellActions(hostId: HostId | null): boolean {
  return hostId !== null;
}

export function hasMarkdownFilePrimaryAction(input: {
  canOpenMedia?: boolean;
  canOpenInPanel: boolean;
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
}): boolean {
  const destinations = [input.canOpenInEditor, input.canOpenInBrowser, input.canOpenInPanel];
  return destinations.some(Boolean) || input.canOpenMedia === true;
}

export function shouldUseMarkdownFileBrowserPrimaryAction(input: {
  canOpenInBrowser: boolean;
  canOpenInEditor: boolean;
  canOpenInPanel: boolean;
  iconPath: string;
}): boolean {
  if (!input.canOpenInBrowser) {
    return false;
  }
  const nothingElseOpens = !input.canOpenInEditor && !input.canOpenInPanel;
  return nothingElseOpens || shouldOpenMarkdownFileLinkInBrowserByDefault(input.iconPath);
}

interface ReplyMarkdownProps {
  /** Anchors relative links and images; the file's own directory for markdown files. */
  imageBaseDir?: string | undefined;
  /** The environment owning markdown that is not tied to a thread, e.g. a PR panel. */
  hostId?: HostId | undefined;
  /** Added to every heading level in the accessibility tree only. */
  headingLevelOffset?: number | undefined;
  /** Parse sanitised raw HTML instead of showing its source. */
  parseRawHtml?: boolean | undefined;
  /** Single newlines are hard breaks: chat-style user input. */
  lineBreaks?: boolean | undefined;
  renderContextReference?: ((reference: ReplyMarkdownContextReference) => ReactNode) | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  skills?: ReadonlyArray<Pick<AgentSkill, "name" | "displayName">> | undefined;
  onImageExpand?: ((preview: ExpandedImageView) => void) | undefined;
  extraRemarkPlugins?: ReadonlyArray<unknown> | undefined;
  threadRef?: HostThreadRef | undefined;
  isStreaming?: boolean | undefined;
  className?: string | undefined;
  cwd: string | undefined;
  text: string;
}

function logActionFailure(context: Record<string, unknown>, cause: unknown): void {
  console.error("[reply-md] action failed", context, cause);
}

function errorText(cause: unknown, fallback = "An error occurred."): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

// ---------------------------------------------------------------------------------------------------------------
// Tree helpers (loose structural types: the markdown stack's own typings are not direct dependencies)
// ---------------------------------------------------------------------------------------------------------------

interface TreeNode {
  type: string;
  tagName?: string;
  value?: string;
  url?: string;
  meta?: string | null;
  data?: { hProperties?: Record<string, unknown>; [key: string]: unknown };
  properties?: Record<string, unknown>;
  children?: TreeNode[];
}

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

function remarkPreserveCodeMeta() {
  return (tree: TreeNode) => {
    const walk = (node: TreeNode): void => {
      const meta = node.type === "code" && typeof node.meta === "string" ? node.meta.trim() : "";
      if (meta !== "") {
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, dataCodeMeta: meta },
        };
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}

/** Windows drive hrefs become file:/// URLs so they survive sanitising; inline code outside links is tagged. */
function remarkNormalizeLinksAndTagInlineCode() {
  return (tree: TreeNode) => {
    const walk = (node: TreeNode, insideLink: boolean): void => {
      const linkLike = node.type === "link" || node.type === "definition";
      if (linkLike && typeof node.url === "string" && WINDOWS_DRIVE_PREFIX.test(node.url)) {
        const forwardSlashed = node.url.replaceAll("\\", "/");
        node.url = "file:///" + forwardSlashed;
      }
      const tagInlineCode = node.type === "inlineCode" && !insideLink;
      if (tagInlineCode) {
        const hProperties = { ...node.data?.hProperties, dataInlineCode: "" };
        node.data = { ...node.data, hProperties };
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      for (const child of node.children ?? []) walk(child, childInsideLink);
    };
    walk(tree, false);
  };
}

const STANDALONE_BLOCKS = new Set([
  "root",
  "p",
  "div",
  "li",
  "td",
  "th",
  "figure",
  "center",
  "blockquote",
]);
const TRANSPARENT_WRAPPERS = new Set(["a", "strong", "em"]);

function meaningfulChildren(node: TreeNode): TreeNode[] {
  return (node.children ?? []).filter(
    (child) => !(child.type === "text" && (child.value ?? "").trim() === ""),
  );
}

function rehypePreserveImageSourceMeta() {
  return (tree: TreeNode) => {
    const visit = (node: TreeNode) => {
      if (node.type === "element" && node.tagName === "img" && node.properties) {
        const src = node.properties.src;
        if (typeof src === "string" && WINDOWS_DRIVE_PREFIX.test(src))
          node.properties.dataLocalSrc = src;
        const title = node.properties.title;
        if (typeof title === "string") node.properties.dataMarkdownTitle = title;
      }
      if (
        node.type === "root" ||
        (node.type === "element" && node.tagName && STANDALONE_BLOCKS.has(node.tagName))
      ) {
        const only = meaningfulChildren(node);
        if (only.length === 1) {
          let candidate: TreeNode | undefined = only[0];
          while (
            candidate?.type === "element" &&
            candidate.tagName &&
            TRANSPARENT_WRAPPERS.has(candidate.tagName)
          ) {
            const inner = meaningfulChildren(candidate);
            if (inner.length !== 1) {
              candidate = undefined;
              break;
            }
            candidate = inner[0];
          }
          if (
            candidate?.type === "element" &&
            candidate.tagName === "img" &&
            candidate.properties
          ) {
            candidate.properties.dataStandalone = true;
          }
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

const GLOBAL_ATTRIBUTE_WITHOUT_TITLE = (attributes: unknown) =>
  (Array.isArray(attributes) ? attributes : []).filter(
    (entry) => entry !== "title" && !(Array.isArray(entry) && entry[0] === "title"),
  );

const baseAttributes = defaultSchema.attributes;
const baseProtocols = defaultSchema.protocols;

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...baseProtocols,
    src: [...(baseProtocols?.src ?? []), "file", "kora-context"],
    href: [...(baseProtocols?.href ?? []), "file", "kora-citation", "kora-context"],
  },
  attributes: {
    ...baseAttributes,
    // GitHub's schema lets <picture><source srcset> through unchecked and the browser then fetches it on its
    // own, bypassing the click-to-load gate for remote media.
    source: [],
    img: [...(baseAttributes?.img ?? []), "dataLocalSrc", "dataMarkdownTitle", "dataStandalone"],
    a: [...(baseAttributes?.a ?? []), "dataPullRequestAutolink"],
    div: [...(baseAttributes?.div ?? []), ...CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES],
    blockquote: [...(baseAttributes?.blockquote ?? []), "dataAlert"],
    code: [...(baseAttributes?.code ?? []), "dataCodeMeta", "dataInlineCode"],
    "*": GLOBAL_ATTRIBUTE_WITHOUT_TITLE(baseAttributes?.["*"]),
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------------

function ordinalGutter(start: number, count: number): string | undefined {
  if (count <= 0) return undefined;
  const widest = [start, start + count - 1].reduce((a, b) =>
    String(b).length > String(a).length ? b : a,
  );
  const width = String(widest).length;
  return width > 1 ? `${width + 1}ch` : undefined;
}

const TASK_LINE = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+)\[[ xX]\]/;

function taskMarkerOffset(source: string, itemOffset: number | undefined): number | null {
  if (itemOffset === undefined) return null;
  const lineEnd = source.indexOf("\n", itemOffset);
  const line = source.slice(itemOffset, lineEnd === -1 ? undefined : lineEnd);
  const match = TASK_LINE.exec(line);
  return match ? itemOffset + match[1]!.length : null;
}

function fenceLanguage(className: string | undefined): string {
  const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1] ?? "text";
  return language === "gitignore" ? "ini" : language;
}

const FILENAME_TOKEN = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;

function fenceTitleFromMeta(meta: string | undefined): string | undefined {
  if (!meta) return undefined;
  const attribute = /(?:^|\s)(?:title|file|filename)=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta);
  const value = attribute?.[1] ?? attribute?.[2] ?? attribute?.[3];
  if (value) return value;
  return meta.split(/\s+/).find((token) => FILENAME_TOKEN.test(token));
}

function flattenText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return flattenText(node.props.children);
  return "";
}

function hastPlainTextDeep(node: TreeNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastPlainTextDeep).join("");
}

function hastHasText(node: TreeNode | undefined): boolean {
  if (!node) return false;
  if (node.type === "text") return (node.value ?? "").trim() !== "";
  return (node.children ?? []).some(hastHasText);
}

function markdownImageCopy(alt: string, src: string, title?: string): string {
  const escapedAlt = alt.replace(/[\\[\]]/g, (c) => `\\${c}`);
  const escapedTitle = title === undefined ? "" : ` "${title.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return `![${escapedAlt}](${src}${escapedTitle})`;
}

function extractInlineCodeSpans(text: string): string[] {
  const spans: string[] = [];
  const fence =
    /(^|\n)[ ]{0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:\n[ ]{0,3}\2[`~]*[ \t]*(?=\n|$))|[\s\S]*$)/g;
  let cursor = 0;
  const take = (segment: string) => {
    for (const match of segment.matchAll(/`([^`\n]+)`/g)) {
      const value = match[1]!.trim();
      if (value) spans.push(value);
    }
  };
  for (const match of text.matchAll(fence)) {
    take(text.slice(cursor, match.index));
    cursor = (match.index ?? 0) + match[0].length;
  }
  take(text.slice(cursor));
  return spans;
}

function normalizeMarkdownLinkHrefKey(href: string): string {
  const destination = normalizeMarkdownLinkDestination(href);
  const rewritten = destination.startsWith("file://")
    ? (rewriteMarkdownFileUriHref(destination) ?? destination)
    : destination;
  return WINDOWS_DRIVE_PREFIX.test(rewritten) ? rewritten.replaceAll("\\", "/") : rewritten;
}

function buildFileLinkParentSuffixByPath(paths: Iterable<string>): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const raw of paths) {
    const path = raw.replaceAll("\\", "/");
    const base = path.slice(path.lastIndexOf("/") + 1);
    let set = groups.get(base);
    if (!set) groups.set(base, (set = new Set()));
    set.add(path);
  }
  const result = new Map<string, string>();
  for (const members of groups.values()) {
    if (members.size < 2) continue;
    const parents = new Map(
      [...members].map((path) => [path, path.split("/").slice(0, -1).filter(Boolean)] as const),
    );
    const maxDepth = Math.max(...[...parents.values()].map((segments) => segments.length));
    let unique = maxDepth;
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const suffixes = [...parents.values()].map((segments) => segments.slice(-depth).join("/"));
      if (new Set(suffixes).size === suffixes.length) {
        unique = depth;
        break;
      }
    }
    for (const [path, segments] of parents) {
      if (segments.length === 0) continue;
      result.set(path, segments.slice(-Math.min(Math.max(unique, 2), segments.length)).join("/"));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Environment shared with the (module-level, referentially stable) component overrides
// ---------------------------------------------------------------------------------------------------------------

interface FileLinkActions {
  openInEditor: (targetPath: string) => void;
  openInPanel: (panelPath: string, line: number | undefined) => void;
  openInBrowser: (targetPath: string) => void;
  openMedia: (source: string, resolvedFilePath?: string, clickedImage?: Element) => void;
  reveal: (targetPath: string) => void;
}

interface MarkdownEnv {
  renderContextReference: ReplyMarkdownProps["renderContextReference"];
  onUseArtifactTemplate: ReplyMarkdownProps["onUseArtifactTemplate"];
  inlineMetaByCode: ReadonlyMap<string, MarkdownFileLinkMeta | null>;
  fileMetaByHref: ReadonlyMap<string, MarkdownFileLinkMeta | null>;
  skills: ReadonlyArray<Pick<AgentSkill, "name" | "displayName">>;
  onTaskListChange: ReplyMarkdownProps["onTaskListChange"];
  openExternalInPreview: (url: string) => Promise<void>;
  onImageExpand: ReplyMarkdownProps["onImageExpand"];
  parentSuffixByPath: ReadonlyMap<string, string>;
  threadRef: HostThreadRef | undefined;
  linkPreference: "app" | "system";
  imageBaseDir: string | undefined;
  revealLabel: string | null;
  headingLevelOffset: number;
  canOpenInBrowser: boolean;
  canOpenInEditor: boolean;
  actions: FileLinkActions;
  theme: "light" | "dark";
  editorMenuLabel: string;
  cwd: string | undefined;
  canOpenInPanel: boolean;
  hostId: HostId | null;
  isStreaming: boolean;
  wordWrap: boolean;
  text: string;
}

const EMPTY_ACTIONS: FileLinkActions = {
  openInEditor: () => {},
  openInPanel: () => {},
  openInBrowser: () => {},
  openMedia: () => {},
  reveal: () => {},
};

const MarkdownEnvContext = createContext<MarkdownEnv>({
  text: "",
  cwd: undefined,
  imageBaseDir: undefined,
  threadRef: undefined,
  hostId: null,
  theme: "dark",
  isStreaming: false,
  skills: [],
  headingLevelOffset: 0,
  onTaskListChange: undefined,
  onUseArtifactTemplate: undefined,
  renderContextReference: undefined,
  onImageExpand: undefined,
  fileMetaByHref: new Map(),
  inlineMetaByCode: new Map(),
  parentSuffixByPath: new Map(),
  actions: EMPTY_ACTIONS,
  canOpenInPanel: false,
  canOpenInBrowser: false,
  canOpenInEditor: false,
  editorMenuLabel: "Open in editor",
  revealLabel: null,
  linkPreference: "system",
  openExternalInPreview: async () => {},
  wordWrap: false,
});

/** Images inside links do not offer the expand affordance. */
const InsideLinkContext = createContext(false);

// ---------------------------------------------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------------------------------------------

function useCopiedFlag(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flag = useCallback(() => {
    clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), 1200);
  }, []);
  return [copied, flag];
}

async function writeClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) throw new Error("Clipboard API unavailable.");
  await clipboard.writeText(text);
}

function ChromeButton(props: {
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  tooltip?: string;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            className="reply-md-chrome-action"
            aria-label={props.label}
            variant="ghost"
            size="icon-xs"
            {...(props.pressed !== undefined ? { "aria-pressed": props.pressed } : {})}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip ?? props.label}</TooltipPopup>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Fenced code
// ---------------------------------------------------------------------------------------------------------------

const highlightCache = new LRUCache<string>(500, 50 * 1024 * 1024);

function highlightCacheKey(code: string, language: string, themeName: string): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function CodeBlockCaption({
  language,
  fenceTitle,
}: {
  language: string;
  fenceTitle: string | undefined;
}) {
  if (fenceTitle) {
    return (
      <>
        <FileEntryIcon pathValue={fenceTitle} kind="file" theme="dark" className="size-3.5" />
        <span className="truncate">{fenceTitle}</span>
      </>
    );
  }
  const synthetic = syntheticFileNameForLanguageId(language);
  if (!hasSpecificFileIconForFileName(synthetic))
    return <span className="truncate">{language}</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span aria-label={`Language: ${language}`} className="inline-flex" />}
      >
        <FileEntryIcon pathValue={synthetic} kind="file" theme="dark" className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{language}</TooltipPopup>
    </Tooltip>
  );
}

function MarkdownCodeBlock(props: {
  code: string;
  language: string;
  fenceTitle: string | undefined;
  theme: "light" | "dark";
  children: ReactNode;
}) {
  const env = useContext(MarkdownEnvContext);
  const [wrapped, setWrapped] = useState(env.wordWrap);
  const [copied, flagCopied] = useCopiedFlag();

  const copy = async () => {
    try {
      await writeClipboard(props.code);
      flagCopied();
    } catch (cause) {
      logActionFailure(
        {
          operation: "copy-code-block",
          language: props.language,
          ...(props.fenceTitle ? { fenceTitle: props.fenceTitle } : {}),
        },
        cause,
      );
    }
  };

  return (
    <div
      className={cn(
        "reply-md-codeblock group/codeblock my-[0.65rem] overflow-hidden rounded-[var(--radius)] bg-secondary leading-snug dark:bg-input/32",
      )}
      data-language={props.language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div className="reply-md-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none">
        <span className="inline-flex min-w-0 items-center gap-[0.4rem] font-mono text-[0.6875rem] opacity-70">
          <CodeBlockCaption language={props.language} fenceTitle={props.fenceTitle} />
        </span>
        <div
          role="toolbar"
          aria-label="Code block actions"
          className="flex gap-0.5 opacity-0 transition-opacity group-focus-within/codeblock:opacity-100 group-hover/codeblock:opacity-100"
        >
          <ChromeButton
            label={wrapped ? "Disable line wrap" : "Wrap lines"}
            pressed={wrapped}
            onClick={() => setWrapped((value) => !value)}
          >
            <WrapTextIcon className="size-3" />
          </ChromeButton>
          <ChromeButton label={copied ? "Copied" : "Copy code"} onClick={() => void copy()}>
            {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </ChromeButton>
        </div>
      </div>
      {props.children}
    </div>
  );
}

function SuspenseShikiCodeBlock(props: {
  className: string | undefined;
  themeName: DiffThemeName;
  isStreaming: boolean;
  code: string;
}) {
  const language = fenceLanguage(props.className);
  // Once a block has streamed it keeps the line-by-line renderer: swapping to cached HTML would clear a selection.
  const hasStreamed = useRef(false);
  if (props.isStreaming) hasStreamed.current = true;

  const key = highlightCacheKey(props.code, language, props.themeName);
  const cached = !props.isStreaming && !hasStreamed.current ? highlightCache.get(key) : null;
  if (cached !== null) {
    return <div className="reply-md-shiki" dangerouslySetInnerHTML={{ __html: cached }} />;
  }
  return (
    <UncachedShikiCode
      code={props.code}
      language={language}
      themeName={props.themeName}
      preserveLines={props.isStreaming || hasStreamed.current}
      streaming={props.isStreaming}
      cacheKey={key}
    />
  );
}

function UncachedShikiCode(props: {
  themeName: DiffThemeName;
  preserveLines: boolean;
  streaming: boolean;
  language: string;
  cacheKey: string;
  code: string;
}) {
  const { code, language, themeName } = props;
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const document = useMemo(
    () => createIncrementalHighlightedDocument(highlighter, language, themeName),
    [highlighter, language, themeName],
  );
  const fallbackDocument = useMemo(
    () => createIncrementalHighlightedDocument(highlighter, "text", themeName),
    [highlighter, themeName],
  );

  const result = useMemo(() => {
    const run = (render: () => unknown) => render();
    try {
      if (props.preserveLines)
        return { root: run(() => document(code)), html: null as string | null };
      return {
        root: null,
        html: highlighter.codeToHtml(code, { lang: language, theme: themeName }),
      };
    } catch (cause) {
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        cause instanceof Error ? cause.message : cause,
      );
      if (props.preserveLines) return { root: run(() => fallbackDocument(code)), html: null };
      return { root: null, html: highlighter.codeToHtml(code, { lang: "text", theme: themeName }) };
    }
    // `document` identity captures highlighter/language/theme.
  }, [code, document, fallbackDocument, highlighter, language, props.preserveLines, themeName]);

  useEffect(() => {
    if (props.streaming) return;
    const html =
      result.html ?? (result.root ? toHtml(result.root as Parameters<typeof toHtml>[0]) : null);
    if (html !== null)
      highlightCache.set(props.cacheKey, html, Math.max(html.length * 2, code.length * 3));
  }, [code.length, props.cacheKey, props.streaming, result]);

  if (result.html !== null) {
    return <div className="reply-md-shiki" dangerouslySetInnerHTML={{ __html: result.html }} />;
  }
  return (
    <div className="reply-md-shiki">
      <HighlightedCodeLines root={result.root as never} />
    </div>
  );
}

function isCodeBlockPre(node: ExtraProps["node"]): HastElement | null {
  const children = (node as unknown as TreeNode | undefined)?.children ?? [];
  const only = children.length === 1 ? children[0] : undefined;
  return only?.type === "element" && only.tagName === "code"
    ? (only as unknown as HastElement)
    : null;
}

type HastElement = TreeNode & { properties?: Record<string, unknown> };

// ---------------------------------------------------------------------------------------------------------------
// Tables, details, alerts, artifact templates
// ---------------------------------------------------------------------------------------------------------------

function MarkdownTable(props: ComponentPropsWithoutRef<"table"> & ExtraProps) {
  const { node: _node, children, ...rest } = props;
  const env = useContext(MarkdownEnvContext);
  const [expanded, setExpanded] = useState(env.wordWrap);
  const [copied, flagCopied] = useCopiedFlag();
  const tableRef = useRef<HTMLTableElement>(null);

  const toggleExpanded = () => {
    const table = tableRef.current;
    if (!expanded && table) {
      // Pin each column to its widest rendered cell so wrapping cannot collapse columns.
      const widths: number[] = [];
      for (const row of Array.from(table.rows)) {
        Array.from(row.cells).forEach((cell, index) => {
          widths[index] = Math.max(widths[index] ?? 0, cell.getBoundingClientRect().width);
        });
      }
      Array.from(table.tHead?.rows[0]?.cells ?? []).forEach((cell, index) => {
        if (widths[index]) cell.style.minWidth = `${Math.ceil(widths[index]!)}px`;
      });
    }
    setExpanded((value) => !value);
  };

  const copy = async (format: "markdown" | "csv") => {
    const table = tableRef.current;
    if (!table || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(
        format === "markdown"
          ? serializeTableElementToMarkdown(table)
          : serializeTableElementToCsv(table),
      );
      flagCopied();
    } catch (cause) {
      logActionFailure({ operation: "copy-table" }, cause);
    }
  };

  return (
    <div className="reply-md-table-container" data-expanded={expanded ? "true" : "false"}>
      <ScrollArea chainVerticalScroll scrollFade className="w-full rounded-none">
        <table ref={tableRef} {...rest}>
          {children}
        </table>
      </ScrollArea>
      <div className="mt-0.5 flex items-center justify-between select-none">
        <ChromeButton
          label={expanded ? "Collapse table cells" : "Expand table cells"}
          pressed={expanded}
          onClick={toggleExpanded}
        >
          {expanded ? <Minimize2Icon className="size-3" /> : <Maximize2Icon className="size-3" />}
        </ChromeButton>
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      aria-label={copied ? "Copied" : "Copy table"}
                      className="reply-md-chrome-action"
                      variant="ghost"
                      size="icon-xs"
                    />
                  }
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copied ? "Copied" : "Copy table"}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => void copy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => void copy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

function MarkdownDetails(props: ComponentPropsWithoutRef<"details"> & ExtraProps) {
  const { node, children, open: openAttribute } = props;
  const [open, setOpen] = useState(openAttribute !== undefined && openAttribute !== false);
  const parts = Children.toArray(children);
  const summary = parts.find(
    (child): child is React.ReactElement<{ children?: ReactNode }> =>
      isValidElement(child) && child.type === "summary",
  );
  const body = parts.filter((child) => child !== summary);
  void node;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={
        <div
          className="reply-md-details my-2 border-y border-border/60"
          data-markdown-details=""
          data-markdown-details-open={open ? "true" : "false"}
        />
      }
    >
      <CollapsibleTrigger
        data-markdown-details-summary=""
        className="flex w-full items-center gap-2 py-2 text-left text-sm font-medium text-foreground"
      >
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {summary ? summary.props.children : "Details"}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div data-markdown-details-content="" className="ps-6 pb-3 text-foreground/90">
          {body}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

const ARTIFACT_ICONS: Record<CodexArtifactTemplate["artifactKind"], LucideIcon> = {
  slack: MessageSquareIcon,
  email: MailIcon,
  image: ImageIcon,
  "google-sheets": FileSpreadsheetIcon,
  "google-slides": PresentationIcon,
  "google-docs": FileTextIcon,
  site: Globe2Icon,
  spreadsheet: FileSpreadsheetIcon,
  presentation: PresentationIcon,
  document: FileTextIcon,
};

const ALERTS: Record<string, { label: string; Icon: LucideIcon; border: string; title: string }> = {
  note: { label: "Note", Icon: InfoIcon, border: "border-foreground/40", title: "text-foreground" },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    border: "border-emerald-500/70",
    title: "text-emerald-600 dark:text-emerald-400",
  },
  important: {
    title: "text-foreground",
    border: "border-foreground/60",
    Icon: MessageSquareWarningIcon,
    label: "Important",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    border: "border-amber-500/70",
    title: "text-amber-600 dark:text-amber-500",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    border: "border-red-500/70",
    title: "text-red-600 dark:text-red-400",
  },
};

function ArtifactTemplateCard({ template }: { template: CodexArtifactTemplate }) {
  const env = useContext(MarkdownEnvContext);
  const Icon = ARTIFACT_ICONS[template.artifactKind];
  const label = codexArtifactTemplatePresentationLabel(template.artifactKind);
  return (
    <div
      role="group"
      aria-label={`${template.displayName} template`}
      className="reply-md-artifact-template my-2 flex items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-2.5"
      data-artifact-kind={template.artifactKind}
      data-markdown-copy={`${template.displayName} (${label})\n\n`}
      data-skill-name={template.skillName}
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{template.displayName}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
      {env.onUseArtifactTemplate ? (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => env.onUseArtifactTemplate?.(template)}
        >
          Use template
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// File links
// ---------------------------------------------------------------------------------------------------------------

type ContextMenuChoice =
  | "preview-media"
  | "open"
  | "open-in-browser"
  | "reveal"
  | "copy-relative"
  | "copy-full";

interface MarkdownFileLinkProps {
  threadRef: HostThreadRef | undefined;
  className?: string | undefined;
  openInEditorMenuLabel: string;
  revealLabel: string | null;
  canOpenInBrowser: boolean;
  panelPath: string | null;
  line: number | undefined;
  canOpenInEditor: boolean;
  actions: FileLinkActions;
  theme: "light" | "dark";
  canOpenMedia: boolean;
  copyMarkdown: string;
  displayPath: string;
  targetPath: string;
  iconPath: string;
  label: string;
  href: string;
}

const fileLinkChipClass =
  "reply-md-file-link cursor-pointer transition-colors hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none";

const MarkdownFileLink = memo(function MarkdownFileLink(props: MarkdownFileLinkProps) {
  const { actions } = props;
  const canOpenInPanel = props.threadRef !== undefined && Boolean(props.panelPath);
  const hasPrimaryAction = hasMarkdownFilePrimaryAction({
    canOpenInEditor: props.canOpenInEditor,
    canOpenInBrowser: props.canOpenInBrowser,
    canOpenInPanel,
    canOpenMedia: props.canOpenMedia,
  });

  const primaryClick = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (props.canOpenInEditor && shouldOpenMarkdownFileLinkInEditor(event.nativeEvent)) {
      actions.openInEditor(props.targetPath);
    } else if (
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: props.iconPath,
        canOpenInEditor: props.canOpenInEditor,
        canOpenInBrowser: props.canOpenInBrowser,
        canOpenInPanel,
      })
    ) {
      actions.openInBrowser(props.targetPath);
    } else if (canOpenInPanel && props.panelPath) {
      actions.openInPanel(props.panelPath, props.line);
    } else if (props.canOpenMedia) {
      actions.openMedia(props.targetPath, props.targetPath);
    } else {
      actions.openInEditor(props.targetPath);
    }
  };

  const showMenu = async (event: ReactMouseEvent<HTMLElement>) => {
    event.stopPropagation();
    event.preventDefault();
    const api = readLocalApi();
    if (!api) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const position =
      event.clientX === 0 && event.clientY === 0
        ? { x: rect.left, y: rect.bottom }
        : { x: event.clientX, y: event.clientY };
    const items: Array<{ id: ContextMenuChoice; label: string }> = [
      ...(props.canOpenMedia ? [{ id: "preview-media" as const, label: "Preview media" }] : []),
      ...(props.canOpenInEditor
        ? [{ id: "open" as const, label: props.openInEditorMenuLabel }]
        : []),
      ...(props.canOpenInBrowser
        ? [{ id: "open-in-browser" as const, label: "Open in integrated browser" }]
        : []),
      ...(props.revealLabel ? [{ id: "reveal" as const, label: props.revealLabel }] : []),
      { id: "copy-relative", label: "Copy relative path" },
      { id: "copy-full", label: "Copy full path" },
    ];
    let choice: ContextMenuChoice | null = null;
    try {
      choice = await api.contextMenu.show(items, position);
    } catch (cause) {
      logActionFailure({ operation: "show-file-context-menu" }, cause);
      return;
    }
    switch (choice) {
      case "preview-media":
        actions.openMedia(props.targetPath, props.targetPath);
        break;
      case "open":
        actions.openInEditor(props.targetPath);
        break;
      case "open-in-browser":
        actions.openInBrowser(props.targetPath);
        break;
      case "reveal":
        actions.reveal(props.targetPath);
        break;
      case "copy-relative":
        await copyPath("relative path", props.displayPath);
        break;
      case "copy-full":
        await copyPath("full path", props.targetPath);
        break;
      default:
        break;
    }
  };

  const chip = hasPrimaryAction ? (
    <a
      href={props.href}
      className={cn(CHAT_FILE_TAG_CHIP_CLASS_NAME, fileLinkChipClass, props.className)}
      data-markdown-copy={props.copyMarkdown}
      onClick={primaryClick}
      onContextMenu={(event) => void showMenu(event)}
    >
      <FileTagBody path={props.iconPath} label={props.label} theme={props.theme} selectable />
    </a>
  ) : (
    <button
      type="button"
      aria-label={`File options for ${props.label}`}
      aria-haspopup="menu"
      className={cn(
        CHAT_FILE_TAG_CHIP_CLASS_NAME,
        fileLinkChipClass,
        "select-text",
        props.className,
      )}
      data-markdown-copy={props.copyMarkdown}
      onClick={(event) => void showMenu(event)}
      onContextMenu={(event) => void showMenu(event)}
    >
      <FileTagBody path={props.iconPath} label={props.label} theme={props.theme} selectable />
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] overflow-x-auto font-mono text-[11px] leading-tight whitespace-nowrap [scrollbar-width:thin]"
      >
        {props.targetPath}
      </TooltipPopup>
    </Tooltip>
  );
});

async function copyPath(kind: "relative path" | "full path", value: string): Promise<void> {
  try {
    await writeClipboard(value);
    const title = kind === "relative path" ? "Relative path" : "Full path";
    toastManager.add({ type: "success", title: `${title} copied`, description: value });
  } catch (cause) {
    toastManager.add(
      threadToast({
        description:
          typeof navigator !== "undefined" && !navigator.clipboard
            ? "Clipboard API unavailable."
            : errorText(cause),
        type: "error",
        title: `Failed to copy ${kind}`,
      }),
    );
  }
}

function fileLinkLabel(meta: MarkdownFileLinkMeta, suffixes: ReadonlyMap<string, string>): string {
  const suffix = suffixes.get(meta.filePath.replaceAll("\\", "/"));
  let label = meta.basename;
  if (suffix) label += ` · ${suffix}`;
  if (meta.line !== undefined)
    label += ` · L${meta.line}${meta.column !== undefined ? `:C${meta.column}` : ""}`;
  return label;
}

function FileLinkFor(props: {
  meta: MarkdownFileLinkMeta;
  href: string;
  copyMarkdown: string;
  className?: string | undefined;
}) {
  const env = useContext(MarkdownEnvContext);
  const { meta } = props;
  const previewable = mediaKindFromPath(meta.basename) !== null;
  const absolute = WINDOWS_DRIVE_PREFIX.test(meta.filePath) || meta.filePath.startsWith("/");
  const panelPath = meta.workspaceRelativePath ?? (!previewable && absolute ? meta.filePath : null);
  return (
    <MarkdownFileLink
      href={props.href}
      targetPath={meta.targetPath}
      iconPath={meta.filePath}
      displayPath={meta.displayPath}
      panelPath={panelPath}
      line={meta.line}
      label={fileLinkLabel(meta, env.parentSuffixByPath)}
      copyMarkdown={props.copyMarkdown}
      theme={env.theme}
      threadRef={env.threadRef}
      canOpenInEditor={env.canOpenInEditor}
      canOpenInBrowser={env.canOpenInBrowser}
      canOpenMedia={env.threadRef !== undefined && previewable}
      openInEditorMenuLabel={env.editorMenuLabel}
      revealLabel={env.revealLabel}
      actions={env.actions}
      className={props.className}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------
// External links
// ---------------------------------------------------------------------------------------------------------------

function isGithubHost(host: string): boolean {
  return host === "github.com" || host.endsWith(".github.com");
}

/** A link's icon is a local glyph: no favicon is fetched from Google or the site (local-only, pl4 S3-12). */
const MarkdownLinkFavicon = memo(function MarkdownLinkFavicon({ host }: { host: string }) {
  const boxClass =
    "ms-[0.25em] me-[0.2em] inline-flex size-3.5 shrink-0 select-none align-[-0.125em]";
  return (
    <span aria-hidden className={boxClass}>
      {isGithubHost(host) ? (
        <GitHubIcon className="size-full shrink-0 text-current" />
      ) : (
        <Globe2Icon className="size-full shrink-0" />
      )}
    </span>
  );
});

function renderLinkChildren(
  children: ReactNode,
  host: string | null,
  hasWords: boolean,
): ReactNode {
  if (!host || !hasWords) return children;
  const parts = Children.toArray(children);
  const first = parts[0];
  const favicon = <MarkdownLinkFavicon host={host} />;
  if (typeof first !== "string" || first.length === 0) {
    return (
      <>
        <span className="whitespace-nowrap">{favicon}</span>
        {children}
      </>
    );
  }
  const prefix = /^https?:\/\//i.exec(first)?.[0] ?? Array.from(first)[0]!;
  const rest = Array.from(first.slice(prefix.length));
  return (
    <>
      <span className="whitespace-nowrap">
        {favicon}
        {prefix}
      </span>
      {rest.map((char, index) => (
        // Position is the identity of a character in a fixed string.
        // oxlint-disable-next-line react/no-array-index-key
        <span key={index} className="contents">
          {char}
          <wbr />
        </span>
      ))}
      {parts.slice(1)}
    </>
  );
}

function decodeFragment(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // keep the raw value
  }
  while (decoded.startsWith("user-content-")) decoded = decoded.slice("user-content-".length);
  return decoded;
}

function findFragmentTarget(anchor: Element, fragment: string): Element | null {
  const wanted = decodeFragment(fragment);
  const matches = (scope: ParentNode) =>
    Array.from(scope.querySelectorAll("[id]")).find(
      (element) => decodeFragment(element.id) === wanted,
    ) ?? null;
  const root = anchor.closest(".reply-md");
  return (root ? matches(root) : null) ?? matches(document);
}

function MarkdownAnchor(props: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  const { node, href, children, onClick, ...rest } = props;
  const env = useContext(MarkdownEnvContext);
  const treeNode = node as unknown as TreeNode | undefined;

  if (href) {
    const footnote = parseReplyFootnoteHref(href);
    if (footnote) return <ReplyFootnoteChip citation={footnote} />;

    const contextRef = parseContextChipHref(href);
    if (contextRef) {
      const label = hastPlainTextDeep(treeNode) || contextRef.contextId;
      return env.renderContextReference ? (
        <>
          {env.renderContextReference({
            kind: contextRef.kind,
            contextId: contextRef.contextId,
            label,
          })}
        </>
      ) : (
        <span>{label}</span>
      );
    }

    const key = normalizeMarkdownLinkHrefKey(href);
    const meta = env.fileMetaByHref.has(key)
      ? env.fileMetaByHref.get(key)
      : resolveMarkdownFileLinkMeta(href, env.cwd, env.imageBaseDir ?? env.cwd);
    if (meta) {
      return <FileLinkFor meta={meta} href={href} copyMarkdown={`[${meta.basename}](${key})`} />;
    }
  }
  return (
    <ExternalAnchor href={href} treeNode={treeNode} onClick={onClick} anchorProps={rest}>
      {children}
    </ExternalAnchor>
  );
}

function ExternalAnchor(props: {
  href: string | undefined;
  treeNode: TreeNode | undefined;
  onClick: ComponentPropsWithoutRef<"a">["onClick"];
  anchorProps: Omit<ComponentPropsWithoutRef<"a">, "href" | "onClick" | "children">;
  children: ReactNode;
}) {
  const { href, treeNode, onClick } = props;
  const env = useContext(MarkdownEnvContext);
  const host = resolveExternalWebLinkHost(href);
  const isFragment = href?.startsWith("#") ?? false;
  const hasWords = hastHasText(treeNode);

  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (!href || event.defaultPrevented) return;
    const plain =
      event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (isFragment) {
      if (!plain) return;
      const target = findFragmentTarget(event.currentTarget, href.slice(1));
      if (!target) return;
      event.preventDefault();
      window.history.pushState(window.history.state, "", href);
      target.scrollIntoView({ block: "nearest" });
      return;
    }
    if (host !== null && plain && mediaKindFromPath(href.split(/[?#]/)[0] ?? "") !== null) {
      event.preventDefault();
      env.actions.openMedia(href, undefined, event.currentTarget.querySelector("img") ?? undefined);
      return;
    }
    const target = resolveLinkTarget({
      url: href,
      event: { metaKey: event.metaKey, ctrlKey: event.ctrlKey },
      preference: env.linkPreference,
      canOpenInApp: canOpenLinksInApp(env.threadRef !== undefined),
    });
    if (target === "app") {
      event.preventDefault();
      void env.openExternalInPreview(href).catch((cause: unknown) => {
        if (cause instanceof BrowserPrefsReadError) return;
        void readLocalApi()?.shell.openExternal(href);
      });
    }
  };

  const showMenu = async (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!href || host === null) return;
    const api = readLocalApi();
    if (!api) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    await showExternalLinkContextMenu({
      href,
      position: { x: event.clientX, y: event.clientY },
      canOpenInPreview: env.threadRef !== undefined,
      showContextMenu: (items, position) => api.contextMenu.show(items, position),
      openInPreview: env.openExternalInPreview,
      openExternal: (target) => api.shell.openExternal(target),
      copyLink: (target) => writeClipboard(target),
      reportFailure: (operation, cause) => logActionFailure({ operation, href }, cause),
    });
  };

  const anchor = (
    <a
      {...props.anchorProps}
      href={href}
      {...(isFragment ? {} : { target: "_blank", rel: "noopener noreferrer" })}
      onClick={handleClick}
      onContextMenu={(event) => void showMenu(event)}
    >
      <InsideLinkContext value>
        {renderLinkChildren(props.children, host, hasWords)}
      </InsideLinkContext>
    </a>
  );
  if (!host || !href) return anchor;
  return (
    <Tooltip>
      <TooltipTrigger render={anchor} />
      <TooltipPopup
        side="top"
        className="max-w-[min(36rem,calc(100vw-2rem))] leading-tight [overflow-wrap:anywhere] whitespace-normal"
      >
        {href}
      </TooltipPopup>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------------------------------------------

function authoredSizeStyle(
  width: string | number | undefined,
  height: string | number | undefined,
): CSSProperties | undefined {
  const w = Number(width);
  const h = Number(height);
  const hasW = Number.isFinite(w) && w > 0;
  const hasH = Number.isFinite(h) && h > 0;
  if (hasW && hasH) {
    return {
      width: `${w}px`,
      height: "auto",
      aspectRatio: `${w} / ${h}`,
      // The height cap folds into the width bound: max-height alone does not feed back through aspect-ratio.
      maxWidth: `min(100%, 30rem, ${(30 * w) / h}rem)`,
    };
  }
  if (hasW) return { maxWidth: `min(100%, 30rem, ${w}px)` };
  if (hasH) return { maxHeight: `min(30rem, ${h}px)` };
  return undefined;
}

function UnavailableMedia(props: { kind: "image" | "video"; alt: string; copyMarkdown: string }) {
  return (
    <span
      className="inline-block rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
      data-markdown-copy={props.copyMarkdown}
    >
      <AlertTriangleIcon className="me-1 inline size-3.5 align-[-0.125em]" aria-hidden />
      {props.kind === "image" ? "Image unavailable" : "Video unavailable"}
      {props.alt ? ` · ${props.alt}` : ""}
    </span>
  );
}

function ReplyMarkdownImage(props: {
  src: string;
  alt: string;
  title: string | undefined;
  standalone: boolean;
  style: CSSProperties | undefined;
  rest: ComponentPropsWithoutRef<"img">;
  actionsSource: MediaActionSource;
  originalUrl: string | undefined;
  copyMarkdown: string;
  onExpand: ((element: Element) => void) | undefined;
}) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const imageRef = useRef<HTMLImageElement | null>(null);
  const { src } = props;

  // A new URL for the same file keeps the previous decoded image on screen; only a cached image that is
  // already complete (no load event will come) is promoted without one.
  const setImage = useCallback(
    (element: HTMLImageElement | null) => {
      imageRef.current = element;
      if (!element) return;
      markdownImageItems.set(element, {
        src,
        name: props.actionsSource.name,
        actionsSource: props.actionsSource,
        ...(props.originalUrl ? { originalUrl: props.originalUrl } : {}),
      });
      if (element.complete && element.naturalWidth > 0) setState("loaded");
    },
    [props.actionsSource, props.originalUrl, src],
  );

  const { width: _w, height: _h, ...imgRest } = props.rest;
  const image = (
    <img
      {...imgRest}
      className={cn(
        "h-auto w-auto rounded-lg border border-border/40 object-contain align-middle",
        "max-h-[30rem] max-w-[min(100%,30rem)]",
        state !== "loaded" && "absolute h-px w-px opacity-0",
        props.onExpand && "cursor-zoom-in",
      )}
      data-markdown-copy={props.copyMarkdown}
      style={props.style}
      draggable={false}
      decoding="async"
      alt={props.alt}
      ref={setImage}
      src={src}
      {...(props.onExpand
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": `Preview ${props.alt || "image"}`,
            onClick: () => props.onExpand?.(imageRef.current!),
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onExpand?.(imageRef.current!);
              }
            },
          }
        : {})}
      onLoad={() => setState("loaded")}
      onError={() => setState("failed")}
    />
  );

  if (state === "loaded") {
    return <MediaActions source={props.actionsSource}>{image}</MediaActions>;
  }
  if (state === "failed") {
    return props.standalone ? (
      <span
        role="alert"
        className="relative my-1 flex aspect-video w-full max-w-[min(100%,30rem)] items-center justify-center overflow-hidden rounded-lg border border-border/40 bg-muted/60 p-2 text-center text-xs text-muted-foreground"
      >
        {props.alt ? `Image unavailable · ${props.alt}` : "Image unavailable"}
      </span>
    ) : (
      <UnavailableMedia kind="image" alt={props.alt} copyMarkdown={props.copyMarkdown} />
    );
  }
  return props.standalone ? (
    <span
      role="status"
      aria-label="Loading image"
      className="relative my-1 block aspect-video w-full max-w-[min(100%,30rem)] overflow-hidden rounded-lg border border-border/40 bg-muted/60"
    >
      {image}
    </span>
  ) : (
    <span role="status" aria-label="Loading image" className="relative inline-block">
      {image}
    </span>
  );
}

function RemoteMediaGate(props: {
  src: string;
  kind: "image" | "video";
  alt: string;
  standalone: boolean;
  copyMarkdown: string;
  children: ReactNode;
}) {
  const host = remoteMediaHost(props.src);
  const [approved, setApproved] = useState(() => host === null || isRemoteMediaApproved(props.src));
  if (approved || host === null || isRemoteMediaApproved(props.src)) return <>{props.children}</>;

  const approve = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    // The gate can sit inside a link; approving must not follow it.
    event.preventDefault();
    event.stopPropagation();
    approveRemoteMedia(props.src);
    setApproved(true);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      data-remote-media-gate=""
      data-markdown-copy={props.copyMarkdown}
      aria-label={`Load ${props.kind} from ${host}${props.alt ? `: ${props.alt}` : ""}`}
      className={cn(
        "inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        props.standalone && "my-1",
      )}
      onClick={approve}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") approve(event);
      }}
    >
      <ImageIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        {props.alt ? `${props.alt} · ` : ""}Load {props.kind} from {host}
      </span>
    </span>
  );
}

function MarkdownImage(props: ComponentPropsWithoutRef<"img"> & ExtraProps) {
  const { node, src: renderedSrc, alt = "", title, ...rest } = props;
  const env = useContext(MarkdownEnvContext);
  const insideLink = useContext(InsideLinkContext);
  const properties = ((node as unknown as TreeNode | undefined)?.properties ?? {}) as Record<
    string,
    unknown
  >;

  const authored = (
    typeof properties.dataLocalSrc === "string" ? properties.dataLocalSrc : renderedSrc
  ) as string | undefined;
  if (!authored)
    return <UnavailableMedia kind="image" alt={alt} copyMarkdown={markdownImageCopy(alt, "")} />;

  const contextRef = parseContextChipHref(authored);
  if (contextRef) {
    const label = alt || contextRef.contextId;
    return env.renderContextReference ? (
      <>
        {env.renderContextReference({
          kind: contextRef.kind,
          contextId: contextRef.contextId,
          label,
        })}
      </>
    ) : (
      <span>{label}</span>
    );
  }

  const markdownTitle =
    typeof properties.dataMarkdownTitle === "string"
      ? properties.dataMarkdownTitle
      : (title ?? undefined);
  const destination = normalizeMarkdownLinkDestination(authored);
  const copyMarkdown = markdownImageCopy(alt, destination, markdownTitle);
  const classified = classifyMarkdownImageSource(destination, env.imageBaseDir ?? env.cwd);
  const kind: "image" | "video" =
    mediaKindFromPath(destination.split(/[?#]/)[0] ?? "") === "video" ? "video" : "image";
  const standalone = properties.dataStandalone === true;

  if (classified._tag !== "Direct") {
    return <UnavailableMedia kind={kind} alt={alt} copyMarkdown={copyMarkdown} />;
  }
  const src = resolveProtocolRelativeMediaUrl(classified.uri);
  const reference: MediaReference | undefined = mediaUrlReference(classified.uri);
  const actionsSource: MediaActionSource = {
    kind,
    name: alt || kind,
    src,
    ...(reference ? { reference } : {}),
  };
  const originalUrl =
    resolveExternalWebLinkHost(classified.uri) !== null ? classified.uri : undefined;

  if (kind === "video") {
    return (
      <RemoteMediaGate src={src} kind="video" alt={alt} standalone copyMarkdown={copyMarkdown}>
        <MediaVideoPlayer
          key={`${copyMarkdown}:${src}`}
          src={src}
          label={alt}
          {...(originalUrl ? { originalUrl } : {})}
          copyMarkdown={copyMarkdown}
          actionsSource={actionsSource}
          className="inline-block w-full max-w-[min(100%,30rem)] overflow-hidden rounded-lg border border-border/40 align-middle"
          videoClassName="max-h-[30rem]"
        />
      </RemoteMediaGate>
    );
  }

  const item = {
    src,
    name: alt || "image",
    actionsSource,
    ...(originalUrl ? { originalUrl } : {}),
  };
  const expand =
    env.onImageExpand && !insideLink
      ? (element: Element) => env.onImageExpand?.(markdownImageGallery(element, item))
      : undefined;
  return (
    <RemoteMediaGate
      src={src}
      kind="image"
      alt={alt}
      standalone={standalone}
      copyMarkdown={copyMarkdown}
    >
      <ReplyMarkdownImage
        src={src}
        alt={alt}
        title={markdownTitle}
        standalone={standalone}
        style={authoredSizeStyle(rest.width, rest.height)}
        rest={rest}
        actionsSource={actionsSource}
        originalUrl={originalUrl}
        copyMarkdown={copyMarkdown}
        onExpand={expand}
      />
    </RemoteMediaGate>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// react-markdown component overrides (module level so identities are stable while streaming)
// ---------------------------------------------------------------------------------------------------------------

function makeHeading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  const level = Number(Tag.slice(1));
  return function MarkdownHeading(props: ComponentPropsWithoutRef<"h1"> & ExtraProps) {
    const { node: _node, ...rest } = props;
    const { headingLevelOffset } = useContext(MarkdownEnvContext);
    return (
      <Tag
        {...rest}
        {...(headingLevelOffset > 0
          ? { "aria-level": Math.min(level + headingLevelOffset, 6) }
          : {})}
      />
    );
  };
}

function MarkdownDiv(props: ComponentPropsWithoutRef<"div"> & ExtraProps) {
  const { node, ...rest } = props;
  const template = artifactTemplateFromHastProperties(
    (node as unknown as TreeNode | undefined)?.properties ?? null,
  );
  return template ? <ArtifactTemplateCard template={template} /> : <div {...rest} />;
}

function MarkdownParagraph(props: ComponentPropsWithoutRef<"p"> & ExtraProps) {
  const { node: _node, children, ...rest } = props;
  const { skills } = useContext(MarkdownEnvContext);
  return <p {...rest}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
}

function MarkdownListItem(props: ComponentPropsWithoutRef<"li"> & ExtraProps) {
  const { node, children, ...rest } = props;
  const env = useContext(MarkdownEnvContext);
  const offset = taskMarkerOffset(
    env.text,
    (node as unknown as { position?: { start?: { offset?: number } } } | undefined)?.position?.start
      ?.offset,
  );
  return (
    <li {...rest} {...(offset !== null ? { "data-task-marker-offset": offset } : {})}>
      {renderSkillInlineMarkdownChildren(children, env.skills)}
    </li>
  );
}

function MarkdownBlockquote(
  props: ComponentPropsWithoutRef<"blockquote"> & ExtraProps & { "data-alert"?: string },
) {
  const { node: _node, children, "data-alert": kind, ...rest } = props;
  const alert = kind ? ALERTS[kind] : undefined;
  if (!alert) return <blockquote {...rest}>{children}</blockquote>;
  const { Icon } = alert;
  // Not a blockquote element: the stylesheet mutes blockquotes, but an alert body is ordinary text.
  return (
    <div role="note" className={cn("my-1 border-l-2 pl-3", alert.border)}>
      <p className={cn("flex items-center gap-1.5 font-medium", alert.title)}>
        <Icon className="size-3.5" aria-hidden />
        {alert.label}
      </p>
      {children}
    </div>
  );
}

function MarkdownOrderedList(props: ComponentPropsWithoutRef<"ol"> & ExtraProps) {
  const { node, style, ...rest } = props;
  const items = ((node as unknown as TreeNode | undefined)?.children ?? []).filter(
    (child) => child.type === "element" && child.tagName === "li",
  ).length;
  const gutter = ordinalGutter(typeof rest.start === "number" ? rest.start : 1, items);
  return (
    <ol
      {...rest}
      style={gutter ? ({ ...style, "--list-gutter": gutter } as CSSProperties) : style}
    />
  );
}

function MarkdownInput(props: ComponentPropsWithoutRef<"input"> & ExtraProps) {
  const { node: _node, type, checked, disabled, ...rest } = props;
  const { onTaskListChange } = useContext(MarkdownEnvContext);
  if (type === "checkbox" && onTaskListChange) {
    return (
      <input
        {...rest}
        onChange={(event) => {
          const item = event.currentTarget.closest("li") as HTMLElement | null;
          const markerOffset = Number(item?.dataset.taskMarkerOffset);
          if (!Number.isSafeInteger(markerOffset)) return;
          onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
        }}
        checked={Boolean(checked)}
        aria-label="Toggle task"
        name="markdown-task"
        type="checkbox"
      />
    );
  }
  return <input {...rest} type={type} checked={checked} disabled={disabled} readOnly />;
}

function MarkdownCode(props: ComponentPropsWithoutRef<"code"> & ExtraProps) {
  const { node: _node, className, children, ...rest } = props;
  const env = useContext(MarkdownEnvContext);
  const inline = "data-inline-code" in (rest as object);
  if (inline) {
    const text = flattenText(children).trim();
    const meta =
      (env.inlineMetaByCode.has(text)
        ? env.inlineMetaByCode.get(text)
        : resolveInlineCodeFileLinkMeta(text, env.cwd, env.imageBaseDir ?? env.cwd)) ?? null;
    if (meta)
      return <FileLinkFor meta={meta} href={meta.targetPath} copyMarkdown={`\`${text}\``} />;
  }
  return (
    <code className={className} {...rest}>
      {children}
    </code>
  );
}

function MarkdownPre(props: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const { node, children, ...rest } = props;
  const env = useContext(MarkdownEnvContext);
  const codeNode = isCodeBlockPre(node);
  if (!codeNode) return <pre {...rest}>{children}</pre>;

  const className = (codeNode.properties?.className as string[] | string | undefined) ?? undefined;
  const classText = Array.isArray(className) ? className.join(" ") : className;
  const code = flattenText(children);
  const language = fenceLanguage(classText);
  const meta =
    typeof codeNode.properties?.dataCodeMeta === "string"
      ? codeNode.properties.dataCodeMeta
      : undefined;
  const themeName = resolveDiffThemeName(env.theme);
  const plain = (hidden: boolean) => (
    <pre {...(hidden ? { "aria-hidden": true, className: "invisible" } : {})}>
      <code>{code}</code>
    </pre>
  );
  return (
    <MarkdownCodeBlock
      code={code}
      language={language}
      fenceTitle={fenceTitleFromMeta(meta)}
      theme={env.theme}
    >
      <RenderErrorBoundary
        fallback={plain(false)}
        resetKeys={[code, language, env.theme, env.isStreaming]}
      >
        <Suspense fallback={plain(true)}>
          <SuspenseShikiCodeBlock
            className={classText}
            code={code}
            themeName={themeName}
            isStreaming={env.isStreaming}
          />
        </Suspense>
      </RenderErrorBoundary>
    </MarkdownCodeBlock>
  );
}

const COMPONENTS = {
  h1: makeHeading("h1"),
  h2: makeHeading("h2"),
  h3: makeHeading("h3"),
  h4: makeHeading("h4"),
  h5: makeHeading("h5"),
  h6: makeHeading("h6"),
  div: MarkdownDiv,
  p: MarkdownParagraph,
  li: MarkdownListItem,
  blockquote: MarkdownBlockquote as Components["blockquote"],
  ol: MarkdownOrderedList,
  input: MarkdownInput,
  a: MarkdownAnchor,
  code: MarkdownCode,
  img: MarkdownImage,
  table: MarkdownTable,
  details: MarkdownDetails,
  pre: MarkdownPre,
} as unknown as Components;

// ---------------------------------------------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------------------------------------------

function urlTransform(url: string): string {
  if (parseReplyFootnoteHref(url) || parseContextChipHref(url) || isWindowsDrivePathHref(url))
    return url;
  return rewriteMarkdownFileUriHref(url) ?? defaultUrlTransform(url);
}

const FENCE_OPENER = /(^|\n) {0,3}(`{3,}|~{3,})/;
const NO_PLUGINS: ReadonlyArray<unknown> = [];
const NO_SKILLS: ReadonlyArray<Pick<AgentSkill, "name" | "displayName">> = [];

function ReplyMarkdown(props: ReplyMarkdownProps) {
  const {
    text,
    cwd,
    threadRef,
    onTaskListChange,
    isStreaming = false,
    skills = NO_SKILLS,
    className,
    lineBreaks = false,
    parseRawHtml = true,
    onUseArtifactTemplate,
    imageBaseDir,
    onImageExpand,
    extraRemarkPlugins = NO_PLUGINS,
    renderContextReference,
    headingLevelOffset = 0,
  } = props;
  const hostId = threadRef?.hostId ?? props.hostId ?? null;
  const { resolvedTheme: theme } = useTheme();
  const wordWrap = useClientPrefs((settings) => settings.wordWrap);
  const linkPreference = useClientPrefs((settings) => settings.browserLinkTarget);
  const rootRef = useRef<HTMLDivElement>(null);
  const incremental = useRef<ReturnType<typeof createIncrementalMarkdownPlugin> | null>(null);
  const [localPreview, setLocalPreview] = useState<ExpandedImageView | null>(null);

  // Local expanded-media state (when the caller gave no onImageExpand) belongs to one place in one thread.
  const scopeKey = `${threadRef?.hostId ?? ""}:${threadRef?.threadId ?? ""}:${props.hostId ?? ""}:${cwd ?? ""}:${imageBaseDir ?? ""}`;
  useEffect(() => setLocalPreview(null), [scopeKey]);

  const availableEditors = useAtomValue(primaryDaemonAvailableEditorsAtom) ?? [];
  const [editor] = useEditorPreference(availableEditors);
  const openInPreferredEditor = useOpenInEditor(hostId, availableEditors);
  const runSearch = useAtomQueryRunner(projectHost.searchEntries, { reportFailure: false });
  const openInEditorCommand = useAtomAction(shellHost.openInEditor, { reportFailure: false });
  const openPreview = useAtomAction(webHost.open, { reportFailure: false });
  const daemonConfigs = useDaemonConfigs();
  const daemonConfig = hostId ? daemonConfigs.get(hostId) : undefined;

  const shellActions = canUseMarkdownFileShellActions(hostId);
  const revealLabel =
    shellActions &&
    daemonConfig?.shellRevealInFileManager === true &&
    daemonConfig.availableEditors.includes("file-manager" as never)
      ? daemonConfig.shellRevealInFileManagerKind
        ? revealInFileExplorerLabelForKind(daemonConfig.shellRevealInFileManagerKind)
        : revealInFileExplorerLabelForOs(daemonConfig.environment.platform.os)
      : null;

  // Everything the stable action callbacks read lives here, replaced on every render.
  const live = useRef<{
    props: ReplyMarkdownProps;
    hostId: HostId | null;
    openInPreferredEditor: typeof openInPreferredEditor;
    runSearch: typeof runSearch;
    openInEditorCommand: typeof openInEditorCommand;
    openPreview: unknown;
  }>(null as never);
  live.current = {
    props,
    hostId,
    openInPreferredEditor,
    runSearch,
    openInEditorCommand,
    openPreview,
  };

  const actions = useMemo<FileLinkActions>(() => {
    const report = (title: string, cause: unknown) =>
      toastManager.add(threadToast({ type: "error", title, description: errorText(cause) }));
    const settled = (title: string, result: unknown) => {
      const r = result as { _tag?: string } | undefined;
      if (!r || r._tag !== "Failure") return;
      if (isAtomActionInterrupted(r as never)) return;
      report(title, squashAtomActionFailure(r as never));
    };

    const lookupBasename = async (
      path: string,
      isLatest: () => boolean,
    ): Promise<string | null | undefined> => {
      const { props: p, hostId: h, runSearch: search } = live.current;
      if (!p.cwd || !h || !needsWorkspaceBasenameLookup(path)) return null;
      const result = (await search({
        hostId: h,
        input: { cwd: p.cwd, query: path, limit: WORKSPACE_BASENAME_LOOKUP_LIMIT, kind: "file" },
      } as never)) as {
        _tag?: string;
        value?: { entries: Array<{ path: string; kind: "file" | "directory" }> };
      };
      if (!isLatest()) return undefined;
      return pickWorkspaceBasenameMatch(
        path,
        result._tag === "Success" ? (result.value?.entries ?? []) : [],
      );
    };

    const openInPanel = async (path: string, line: number | undefined) => {
      const ref = live.current.props.threadRef;
      const isLatest = claimWorkspaceBasenameLookup();
      if (!ref) return;
      if (fileLinkOutsideFolder(path, live.current.props.cwd)) {
        const ok = await localApiOrThrow().dialogs.confirm(
          `Open a file outside this thread's folder?\n${path}`,
        );
        if (!ok) return;
      }
      const match = await lookupBasename(path, isLatest);
      if (match === undefined) return; // a newer open superseded this lookup
      useDockStore.getState().openFile(ref, match ?? path, line);
    };

    const openMedia = (source: string, resolvedFilePath?: string, clickedImage?: Element) => {
      const { props: p } = live.current;
      const preview = resolveMarkdownMediaPreview({
        source,
        resolvedFilePath,
        cwd: p.cwd,
        threadRef: p.threadRef,
      });
      const expand = (view: ExpandedImageView) =>
        p.onImageExpand ? p.onImageExpand(view) : setLocalPreview(view);
      if (preview) {
        const selected = preview.images[preview.index]!;
        const root = rootRef.current;
        if (selected.type !== "video" && root)
          expand(markdownImageGallery(clickedImage ?? root, selected));
        else expand(preview);
        return;
      }
      if (p.threadRef && resolvedFilePath) {
        const relative =
          mediaFileReference(resolvedFilePath, p.cwd).relativePath ?? resolvedFilePath;
        useDockStore.getState().openFile(p.threadRef, relative, undefined);
      }
    };

    return {
      openInEditor: (targetPath) =>
        void Promise.resolve(live.current.openInPreferredEditor(targetPath)).then(
          (result) => settled("Unable to open file", result),
          (cause) => report("Unable to open file", cause),
        ),
      openInPanel: (path, line) => void openInPanel(path, line),
      openInBrowser: (targetPath) => {
        const ref = live.current.props.threadRef;
        const command = live.current.openPreview as
          | ((input: unknown) => Promise<unknown>)
          | undefined;
        if (!ref || !command) return;
        const url = `file://${targetPath.startsWith("/") ? "" : "/"}${encodeURI(targetPath.replaceAll("\\", "/"))}`;
        void openUrlInWeb({ threadRef: ref, url, openPreview: command as never }).then(
          (result) => settled("Unable to open file in browser", result),
          (cause) => report("Unable to open file in browser", cause),
        );
      },
      openMedia,
      reveal: (targetPath) => {
        const { hostId: h } = live.current;
        void (async () => {
          try {
            if (!h) throw new Error("Cannot reveal a file without an environment.");
            let file = targetPath;
            const match = await lookupBasename(targetPath, claimWorkspaceBasenameLookup());
            if (match === undefined) return;
            if (match && live.current.props.cwd)
              file = `${live.current.props.cwd.replace(/[\\/]+$/, "")}/${match}`;
            const result = await live.current.openInEditorCommand({
              hostId: h,
              input: { cwd: file, editor: "file-manager", reveal: true },
            } as never);
            settled("Unable to reveal file", result);
          } catch (cause) {
            report("Unable to reveal file", cause);
          }
        })();
      },
    };
  }, []);

  const openExternalInPreview = useCallback(
    async (url: string) => {
      if (!threadRef)
        throw new BrowserWebUnavailableError({ message: "Thread context is unavailable." });
      const result = await openUrlInWeb({ threadRef, url, openPreview: openPreview as never });
      if (result._tag === "Success") {
        rememberThreadVisit(threadRef, url);
        return;
      }
      if (isAtomActionInterrupted(result)) return;
      const failure = squashAtomActionFailure(result);
      if (failure instanceof BrowserPrefsReadError) {
        toastManager.add(
          threadToast({
            description: errorText(failure),
            title: "Unable to open link in browser",
            type: "error",
          }),
        );
      }
      throw failure;
    },
    [openPreview, threadRef],
  );

  // File-link metadata for every href and inline-code span in the message.
  const { fileMetaByHref, inlineMetaByCode, parentSuffixByPath } = useMemo(() => {
    const byHref = new Map<string, MarkdownFileLinkMeta | null>();
    const byCode = new Map<string, MarkdownFileLinkMeta | null>();
    const base = imageBaseDir ?? cwd;
    for (const href of extractMarkdownLinkHrefs(renderCodexFileFootnotesAsMarkdown(text))) {
      if (parseContextChipHref(href)) continue;
      const key = normalizeMarkdownLinkHrefKey(href);
      if (!byHref.has(key)) byHref.set(key, resolveMarkdownFileLinkMeta(href, cwd, base));
    }
    for (const span of extractInlineCodeSpans(text)) {
      if (!byCode.has(span)) byCode.set(span, resolveInlineCodeFileLinkMeta(span, cwd, base));
    }
    const paths = new Set<string>();
    for (const meta of [...byHref.values(), ...byCode.values()]) if (meta) paths.add(meta.filePath);
    return {
      fileMetaByHref: byHref,
      inlineMetaByCode: byCode,
      parentSuffixByPath: buildFileLinkParentSuffixByPath(paths),
    };
  }, [cwd, imageBaseDir, text]);

  const canOpenInPanel = threadRef !== undefined;
  const env = useMemo<MarkdownEnv>(
    () => ({
      text,
      cwd,
      imageBaseDir,
      threadRef,
      hostId,
      theme,
      isStreaming,
      skills,
      headingLevelOffset,
      onTaskListChange,
      onUseArtifactTemplate,
      renderContextReference,
      onImageExpand: onImageExpand ?? ((view) => setLocalPreview(view)),
      fileMetaByHref,
      inlineMetaByCode,
      parentSuffixByPath,
      actions,
      canOpenInEditor: shellActions,
      canOpenInBrowser: threadRef !== undefined,
      canOpenInPanel,
      editorMenuLabel: openInEditorMenuLabel(editor),
      revealLabel,
      linkPreference,
      openExternalInPreview,
      wordWrap,
    }),
    [
      text,
      cwd,
      imageBaseDir,
      threadRef,
      hostId,
      theme,
      isStreaming,
      skills,
      headingLevelOffset,
      onTaskListChange,
      onUseArtifactTemplate,
      renderContextReference,
      onImageExpand,
      fileMetaByHref,
      inlineMetaByCode,
      parentSuffixByPath,
      actions,
      shellActions,
      canOpenInPanel,
      editor,
      revealLabel,
      linkPreference,
      openExternalInPreview,
      wordWrap,
    ],
  );

  const useIncremental = isStreaming && extraRemarkPlugins.length === 0 && FENCE_OPENER.test(text);
  if (useIncremental && incremental.current === null)
    incremental.current = createIncrementalMarkdownPlugin();

  const early = [remarkGithubAlerts, remarkNormalizeListItemIndentation, remarkCodexDirectives];
  const remarkPlugins = [
    remarkGfm,
    ...early,
    ...(lineBreaks ? [remarkBreaks] : []),
    remarkPreserveCodeMeta,
    remarkNormalizeLinksAndTagInlineCode,
    ...extraRemarkPlugins,
    ...(useIncremental && incremental.current ? [incremental.current] : []),
  ];
  const rehypePlugins = parseRawHtml
    ? [rehypeRaw, rehypePreserveImageSourceMeta, [rehypeSanitize, SANITIZE_SCHEMA]]
    : [rehypePreserveImageSourceMeta, [rehypeSanitize, SANITIZE_SCHEMA]];

  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const payload = replyMarkdownClipboardPayload(selection);
    if (!payload) return;
    const fragment = event.clipboardData.getData(CONTEXT_CHIP_CLIPBOARD_MIME);
    const html = fragment
      ? encodeContextChipClipboardHtml(payload.text, fragment, payload.html)
      : payload.html;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", html);
    if (fragment) event.clipboardData.setData(CONTEXT_CHIP_CLIPBOARD_MIME, fragment);
  };

  return (
    <MarkdownEnvContext value={env}>
      <div
        ref={rootRef}
        className={cn(
          "reply-md w-full min-w-0 text-[15px] leading-[1.65] text-foreground [overflow-wrap:anywhere] [word-break:break-word]",
          className,
        )}
        {...(isStreaming ? { "data-streaming": "" } : {})}
        onCopy={onCopy}
      >
        <ReactMarkdown
          remarkPlugins={remarkPlugins as never}
          rehypePlugins={rehypePlugins as never}
          components={COMPONENTS}
          urlTransform={urlTransform}
          skipHtml={false}
        >
          {text}
        </ReactMarkdown>
      </div>
      {localPreview && !onImageExpand ? (
        <ExpandedImageDialog preview={localPreview} onClose={() => setLocalPreview(null)} />
      ) : null}
    </MarkdownEnvContext>
  );
}

export default memo(ReplyMarkdown);
