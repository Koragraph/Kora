import { HostId } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { act, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { getSyntaxHighlighterPromise } from "../util/syntaxHighlighting";
import { GitHubIcon } from "./BrandIcons";
import { Button } from "./ui/button";
import { setMarkdownTaskChecked } from "./viewer/fileViewerMode";

vi.mock("~/lib/openPullRequestLink", () => ({
  useOpenChangeRequestLink: () => vi.fn(),
  parseChangeRequestUrl: () => null,
  findProjectOnChangeRequestHost: () => undefined,
}));
vi.mock("../workspace/editorPreferences", () => ({
  useEditorPreference: () => [null, vi.fn()],
  useOpenInEditor: () => vi.fn(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../atoms/entities", () => ({
  useDaemonConfigs: () => new Map(),
  useProjects: () => [],
  readThreadSummary: () => null,
}));
vi.mock("../atoms/session", async (loadReal) => ({
  ...(await loadReal<typeof import("../atoms/session")>()),
  usePreparedLink: () => ({ _tag: "Loading" }),
}));
vi.mock("../atoms/use-atom-command", () => ({ useAtomAction: () => vi.fn() }));
vi.mock("../atoms/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("./ui/tooltip", async () => {
  const react = await import("react");
  return {
    Tooltip: (props: { children: ReactNode }) => <>{props.children}</>,
    TooltipPopup: () => null,
    TooltipTrigger(props: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      const { render, children } = props;
      if (!react.isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : react.cloneElement(render, undefined, children);
    },
  };
});
vi.mock("../hooks/usePrefs", async (loadReal) => {
  const real = await loadReal<typeof import("../hooks/usePrefs")>();
  const prefs = real.getClientPrefs();
  return {
    ...real,
    useClientPrefs: (pick?: (all: typeof prefs) => unknown) => (pick ? pick(prefs) : prefs),
  };
});
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));

import ReplyMarkdown, {
  canUseMarkdownFileShellActions,
  hasMarkdownFilePrimaryAction,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./ReplyMarkdown";

type MdProps = Partial<ComponentProps<typeof ReplyMarkdown>>;

const ROOT = "/tmp/project";
const WIN_ROOT = "C:/Users/shawn/project";
const REPORT = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
const TEMPLATE_CARD =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

const render = (text: string, props: MdProps = {}) =>
  renderToStaticMarkup(<ReplyMarkdown cwd={ROOT} text={text} {...props} />);
const plain = (markup: string) => markup.replace(/<[^>]+>/g, "");
const parseModes = [true, false] as const;
const modeProps = (parseRawHtml: boolean): MdProps => ({ parseRawHtml, lineBreaks: !parseRawHtml });

/** Mount with react-test-renderer inside act, and always unmount + unstub afterwards. */
async function mounted(
  first: ReactElement,
  scenario: (
    view: ReactTestRenderer,
    redraw: (next: ReactElement) => Promise<void>,
  ) => Promise<void>,
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      view = create(first);
    });
    await scenario(view!, async (next) => {
      await act(async () => {
        view!.update(next);
      });
    });
  } finally {
    await act(async () => view?.unmount());
    vi.unstubAllGlobals();
  }
}

const imgSrcs = (view: ReactTestRenderer) => view.root.findAllByType("img").map((i) => i.props.src);
const press = (handler: unknown) => (handler as (e: unknown) => void)({});

function iconButton(view: ReactTestRenderer, label: string) {
  const found = view.root.findAllByType(Button).find((b) => b.props["aria-label"] === label);
  if (!found) throw new Error(`no button labelled ${label}`);
  return found.props as ComponentProps<typeof Button>;
}

const highlighterFor = (lang: string) => getSyntaxHighlighterPromise(lang as never);

afterEach(() => {
  // fake timers and spies must not leak between tests
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("codex file citations", () => {
  test("a citation becomes a file chip and carries a copy payload", () => {
    for (const mode of parseModes) {
      const out = render(
        'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx" purpose="output"}.',
        modeProps(mode),
      );
      expect(out).not.toContain("codex-file-citation");
      expect(out).toContain("reply-md-file-link");
      expect(out).toContain('data-markdown-copy="[report.xlsx](/tmp/project/outputs/report.xlsx)"');
    }
  });

  test("same basename in two folders gets a folder hint", () => {
    const out = render(
      'Changed :codex-file-citation{path="/tmp/project/src/index.ts"} and :codex-file-citation{path="/tmp/project/test/index.ts"}.',
    );
    expect(out).toContain("index.ts · project/src");
    expect(out).toContain("index.ts · project/test");
  });

  test("a citation inside a list item with deep indent is still a chip, not a code block", () => {
    const out = render(`-       Created ${REPORT}`);
    expect(out).not.toContain("<pre>");
    expect(out).toContain("reply-md-file-link");
  });

  test("rejected citations in that same recovery path stay as visible text", () => {
    const bad = render('Lead.\n\n-       Bad :codex-file-citation{purpose="output"}');
    expect(bad).toContain("<li>Bad :codex-file-citation{purpose=&quot;output&quot;}</li>");
    const inLink = render(`Lead.\n\n-       [Bad ${REPORT}](https://example.com)`);
    expect(plain(inLink)).toContain(
      "Bad :codex-file-citation{path=&quot;/tmp/project/outputs/report.xlsx&quot;}",
    );
  });

  test.each([
    ["inside link text", `[See ${REPORT}](https://example.com)`],
    ["escaped", `Example: \\${REPORT}`],
    ["unterminated while streaming", REPORT.slice(0, -1)],
    ["missing path", ':codex-file-citation{purpose="output"}'],
    ["lookalike name", ':codex-file-citation-extra{path="/tmp/project/outputs/report.xlsx"}'],
  ])("stays literal when %s", (_label, text) => {
    const out = render(text);
    expect(plain(out)).toContain("codex-file-citation");
    expect(out).not.toContain("reply-md-file-link");
  });

  test("examples inside inline code and fences are not rewritten", () => {
    const out = render(`Ex: \`${REPORT}\`\n\n\`\`\`text\n${REPORT}\n\`\`\``);
    expect(out.match(/:codex-file-citation/g)).toHaveLength(2);
    expect(out).not.toContain("reply-md-file-link");
  });

  test("plain path links fall back to a selectable menu button", () => {
    const out = render("[Source](/tmp/project/src/main.ts)");
    expect(out).toContain("<button");
    expect(out).toContain('aria-haspopup="menu"');
    expect(out).toContain("select-text");
  });
});

describe("skill chips", () => {
  test("labels track the discovered skill list as it changes", async () => {
    const body = "Use $2spec with a $20k budget.";
    await mounted(<ReplyMarkdown cwd={ROOT} text={body} />, async (view, redraw) => {
      const spans = (label: string) =>
        view.root.findAllByType("span").filter((s) => s.children.includes(label));
      expect(spans("2Spec")).toHaveLength(0);

      await redraw(
        <ReplyMarkdown
          cwd={ROOT}
          text={body}
          skills={[
            { name: "2spec", displayName: "2Spec" },
            { name: "20k", displayName: "MoneySkill" },
          ]}
        />,
      );
      expect(spans("2Spec")).toHaveLength(1);
      expect(spans("MoneySkill")).toHaveLength(0);

      await redraw(<ReplyMarkdown cwd={ROOT} text={body} skills={[]} />);
      expect(spans("2Spec")).toHaveLength(0);
    });
  });
});

describe("file action predicates", () => {
  const caps = (canOpenInPanel: boolean, canOpenInBrowser: boolean, canOpenInEditor: boolean) => ({
    canOpenInPanel,
    canOpenInBrowser,
    canOpenInEditor,
  });

  test("the chip is interactive iff some opener exists", () => {
    expect(hasMarkdownFilePrimaryAction(caps(false, false, false))).toBe(false);
    expect(hasMarkdownFilePrimaryAction(caps(true, false, false))).toBe(true);
    expect(hasMarkdownFilePrimaryAction(caps(false, true, false))).toBe(true);
    expect(hasMarkdownFilePrimaryAction(caps(false, false, true))).toBe(true);
  });

  test("shell actions need an owning host", () => {
    expect(canUseMarkdownFileShellActions(null)).toBe(false);
    expect(canUseMarkdownFileShellActions(HostId.make("host-1"))).toBe(true);
  });

  test("browser is primary for PDFs, and for others only when it is the sole opener", () => {
    const pdf = { ...caps(true, true, true), iconPath: "/tmp/a.pdf" };
    const html = (c: ReturnType<typeof caps>) => ({ ...c, iconPath: "/tmp/a.html" });
    expect(shouldUseMarkdownFileBrowserPrimaryAction(pdf)).toBe(true);
    expect(shouldUseMarkdownFileBrowserPrimaryAction(html(caps(false, true, true)))).toBe(false);
    expect(shouldUseMarkdownFileBrowserPrimaryAction(html(caps(true, true, false)))).toBe(false);
    expect(shouldUseMarkdownFileBrowserPrimaryAction(html(caps(false, true, false)))).toBe(true);
  });
});

describe("streaming", () => {
  const tickEvent = (offset: unknown) =>
    ({
      currentTarget: {
        checked: true,
        closest: () => ({ dataset: { taskMarkerOffset: `${offset}` } }),
      },
    }) as never;

  test("ticking a task box edits the current text even after the renderer was reused", async () => {
    const written: string[] = [];
    let view!: ReactTestRenderer;
    const doc = (text: string): ReactElement => (
      <ReplyMarkdown
        cwd={ROOT}
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          const next = setMarkdownTaskChecked(text, markerOffset, checked);
          written.push(next);
          view.update(doc(next));
        }}
      />
    );
    await mounted(doc("- [ ] First\n- [ ] Second"), async (v, redraw) => {
      view = v;
      const secondBox = () => v.root.findAllByType("input")[1]!;
      const original = secondBox();
      await redraw(doc("- [ ] A longer first task\n- [ ] Second"));

      const offset = v.root.findAllByType("li")[1]!.props["data-task-marker-offset"];
      const handler = (secondBox().props as ComponentProps<"input">).onChange;
      expect(handler).toBeTypeOf("function");
      await act(async () => {
        handler!(tickEvent(offset));
      });

      expect(secondBox()).toBe(original);
      expect(written).toEqual(["- [ ] A longer first task\n- [x] Second"]);
      expect(secondBox().props.checked).toBe(true);
    });
  });

  test("later streamed text leaves an unchanged fence and open details alone", async () => {
    const tokenize = vi.spyOn(await highlighterFor("text"), "codeToHast");
    const writeText = vi.fn(async (_s: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const base =
      "```text\nFirst code block\n```\n\n<details><summary>More</summary>\n\nDetails content\n\n</details>\n\nStreaming reply";
    const stream = (text: string) => <ReplyMarkdown cwd={ROOT} text={text} isStreaming />;

    await mounted(stream(base), async (view, redraw) => {
      const fenceNow = () => view.root.findByProps({ "data-language": "text" });
      const detailsNow = () => view.root.findByProps({ "data-markdown-details": "" });
      const fence = fenceNow();
      const startedWrapped = fence.props["data-wrap"] === "true";

      await act(async () => {
        press(iconButton(view, startedWrapped ? "Disable line wrap" : "Wrap lines").onClick);
        press(iconButton(view, "Copy code").onClick);
      });
      await act(async () => {
        view.root
          .find((n) => n.type === "button" && n.props["data-markdown-details-summary"] === "")
          .props.onClick({ nativeEvent: new Event("click") });
      });
      const details = detailsNow();
      expect({
        open: details.props["data-markdown-details-open"],
        copied: writeText.mock.calls,
        passes: tokenize.mock.calls.length,
      }).toEqual({ open: "true", copied: [["First code block\n"]], passes: 1 });

      for (const n of Array.from({ length: 10 }, (_, i) => i)) await redraw(stream(`${base} ${n}`));

      expect(tokenize.mock.calls.length).toBe(1);
      expect([fenceNow(), detailsNow()]).toEqual([fence, details]);
      expect(fence.props["data-wrap"]).toBe(`${!startedWrapped}`);
      expect(details.props["data-markdown-details-open"]).toBe("true");

      await redraw(stream(base.replace("First code block", "Updated code block")));
      await act(async () => {
        press(iconButton(view, "Copied").onClick);
      });
      expect(writeText).toHaveBeenLastCalledWith("Updated code block\n");
      expect(tokenize.mock.calls.length).toBe(2);
    });
  });

  test("a fence that failed to highlight recovers on new content without losing its toggles", async () => {
    const shiki = await highlighterFor("text");
    const passthrough = shiki.codeToHast.bind(shiki);
    const health = { broken: true };
    vi.spyOn(shiki, "codeToHast").mockImplementation((...args) => {
      if (health.broken) throw new Error("highlighter hiccup");
      return passthrough(...args);
    });
    for (const channel of ["error", "warn"] as const) {
      vi.spyOn(console, channel).mockImplementation(() => {});
    }
    const fenced = (body: string) => (
      <ReplyMarkdown cwd={ROOT} text={"```text\n" + body + "\n```"} isStreaming />
    );

    await mounted(fenced("initial"), async (view, redraw) => {
      const highlighted = () => view.root.findAllByProps({ className: "reply-md-shiki" }).length;
      const fence = view.root.findByProps({ "data-language": "text" });
      const startedWrapped = fence.props["data-wrap"] === "true";
      await act(async () => {
        press(iconButton(view, startedWrapped ? "Disable line wrap" : "Wrap lines").onClick);
      });
      expect(highlighted()).toBe(0);

      health.broken = false;
      await redraw(fenced("recovered"));
      expect(highlighted()).toBe(1);
      expect(view.root.findByProps({ "data-language": "text" })).toBe(fence);
      expect(fence.props["data-wrap"]).toBe(`${!startedWrapped}`);
    });
  });

  test("closing the stream does not re-tokenize lines that were already done", async () => {
    const tokenize = vi.spyOn(await highlighterFor("typescript"), "codeToHast");
    const open = "```typescript\nconst completed = 1;\nconst current = 2;";
    await mounted(<ReplyMarkdown cwd={ROOT} text={open} isStreaming />, async (_view, redraw) => {
      expect(tokenize).toHaveBeenCalled();
      tokenize.mockClear();
      await redraw(<ReplyMarkdown cwd={ROOT} text={`${open}\n\`\`\``} />);
      for (const [code] of tokenize.mock.calls) expect(code).not.toContain("const completed");
    });
  });
});

describe("remote media and favicons", () => {
  test("no link ever triggers an <img> fetch, and GitHub links use the local mark", async () => {
    const link = (url: string) => <ReplyMarkdown cwd={ROOT} text={`[Link](${url})`} />;
    await mounted(link("https://example.com"), async (view, redraw) => {
      expect(view.root.findAllByType("img")).toHaveLength(0);
      const others = [
        "https://c2VjcmV0.attacker-site.com/",
        "http://home.arpa",
        "http://10.0.0.7:81",
      ];
      for (const url of others) {
        await redraw(link(url));
        expect(view.root.findAllByType("img")).toHaveLength(0);
      }
      await redraw(link("https://github.com/agilkatakam/kora/pull/1"));
      expect(view.root.findAllByType("img")).toHaveLength(0);
      expect(view.root.findAllByType(GitHubIcon)).toHaveLength(1);
    });
  });

  test("data: and loopback images load directly", () => {
    const out = render(
      "![a](data:image/png;base64,iVBORw0KGgo=) ![b](http://localhost:5173/shot.png)",
    );
    expect(out).not.toContain("data-remote-media-gate");
    expect(out).toContain("http://localhost:5173/shot.png");
  });

  test("raw <picture> markup is gated as well and srcset is dropped", () => {
    const out = render(
      '<picture><source srcset="https://evil.example/a.png?d=1"><img src="https://evil.example/b.png?d=2"></picture>',
    );
    expect(out).not.toContain("evil.example/a.png");
    expect(out).not.toContain('src="https://evil.example/b.png');
    expect(out).toContain("data-remote-media-gate");
  });

  test("a remote image loads only after the reader clicks its placeholder", async () => {
    const src = "https://evil.example/pixel.png?d=c2VjcmV0";
    await mounted(<ReplyMarkdown cwd={ROOT} text={`![chart](${src})`} />, async (view) => {
      expect(imgSrcs(view)).not.toContain(src);
      const gate = view.root.find(
        (n) => n.type === "span" && n.props["data-remote-media-gate"] === "",
      );
      expect(gate.props["aria-label"]).toContain("evil.example");
      await act(async () => {
        gate.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
      });
      expect(imgSrcs(view)).toContain(src);
    });
  });
});

describe("context references", () => {
  test("a formatted label reaches the renderer as flattened text", async () => {
    const calls: string[] = [];
    await mounted(
      <ReplyMarkdown
        cwd={undefined}
        text="See [**Bold** `code`](kora-context://v1/terminal/term-1)."
        renderContextReference={({ kind, label }) => {
          calls.push(`${kind}: ${label}`);
          return <button>{label}</button>;
        }}
      />,
      async () => {
        expect(calls).toEqual(["terminal: Bold code"]);
      },
    );
  });

  test("text and image references use the chip renderer, else degrade to plain spans", async () => {
    const text =
      "See [Terminal output](kora-context://v1/terminal/term-1) and ![Error image](kora-context://v1/image/img-1).";
    const chip = ({ kind, label }: { kind: string; label: string }) => (
      <button>{`${kind}: ${label}`}</button>
    );
    const withChips = <ReplyMarkdown cwd={undefined} text={text} renderContextReference={chip} />;
    await mounted(withChips, async (view, redraw) => {
      expect(view.root.findAllByType("button").map((b) => b.children.join(""))).toEqual([
        "terminal: Terminal output",
        "image: Error image",
      ]);
      expect(view.root.findAllByType("img")).toHaveLength(0);
      expect(view.root.findAllByType("a")).toHaveLength(0);

      await redraw(<ReplyMarkdown cwd={undefined} text={text} />);
      expect(view.root.findAllByType("span").map((s) => s.children.join(""))).toEqual([
        "Terminal output",
        "Error image",
      ]);
      expect(view.root.findAllByType("img")).toHaveLength(0);
    });
  });
});

describe("windows paths", () => {
  const win = (text: string, mode: boolean) =>
    render(text, { cwd: WIN_ROOT, hostId: HostId.make("win"), ...modeProps(mode) });

  test.each(parseModes)("unsafe schemes are dropped (parseRawHtml=%s)", (mode) => {
    const out = win("[unsafe](javascript:alert(1)) and [unknown](d:alert(1))", mode);
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("d:alert");
    expect(out).not.toContain("reply-md-file-link");
  });

  test.each(parseModes)(
    "reference-style links resolve to a file chip (parseRawHtml=%s)",
    (mode) => {
      const out = win("[Open][src]\n\n[src]: C:/Users/shawn/project/src/main.ts", mode);
      expect(out).toContain('href="C:/Users/shawn/project/src/main.ts"');
      expect(out).toContain("reply-md-file-link");
    },
  );

  test.each(parseModes)("backslashes become forward slashes (parseRawHtml=%s)", (mode) => {
    const out = win(String.raw`[Open](C:\Users\shawn\project\src\main.ts)`, mode);
    expect(out).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(out).toContain("reply-md-file-link");
  });

  test.each(parseModes)("drive paths pass through (parseRawHtml=%s)", (mode) => {
    const out = win("[Open](C:/Users/shawn/project/src/main.ts)", mode);
    expect(out).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(out).toContain("reply-md-file-link");
  });

  test.each(parseModes)(
    "a link and inline code to one file need no folder hint (parseRawHtml=%s)",
    (mode) => {
      const p = String.raw`C:\Users\shawn\project\src\main.ts`;
      const out = win(`[Source](${p}) and \`${p}\``, mode);
      expect(out.match(/reply-md-file-link/g)).toHaveLength(2);
      expect(out).not.toContain("main.ts ·");
    },
  );

  test.each(parseModes)(
    "different folders with one file name get hints (parseRawHtml=%s)",
    (mode) => {
      const out = win(
        String.raw`[A](C:\Users\shawn\project\src\index.ts) and [B](C:\Users\shawn\project\test\index.ts)`,
        mode,
      );
      expect(out).toContain("index.ts · project/src");
      expect(out).toContain("index.ts · project/test");
    },
  );
});

describe("headings", () => {
  test("without an offset headings are untouched", () => {
    expect(render("# Top")).toContain("<h1>Top</h1>");
  });

  test("an offset sets aria-level but keeps the tags", () => {
    const out = render("# Top\n\n## Section\n\n###### Fine print", { headingLevelOffset: 3 });
    expect(out).toContain('<h1 aria-level="4">Top</h1>');
    expect(out).toContain('<h2 aria-level="5">Section</h2>');
    expect(out).toContain('<h6 aria-level="6">Fine print</h6>');
  });
});

describe("artifact-template directive", () => {
  test("not interpreted inside code", () => {
    const out = render(`\`${TEMPLATE_CARD}\`\n\n\`\`\`text\n${TEMPLATE_CARD}\n\`\`\``);
    expect(out.match(/::artifact-template/g)).toHaveLength(2);
    expect(out).not.toContain("reply-md-artifact-template");
  });

  test.each([
    ["escaped", `\\${TEMPLATE_CARD}`],
    ["lookalike", TEMPLATE_CARD.replace("::artifact-template", "::artifact-template-extra")],
    [
      "missing skill_directory",
      '::artifact-template{skill_name="artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}',
    ],
    ["unterminated", TEMPLATE_CARD.slice(0, -1)],
  ])("%s stays literal", (_label, text) => {
    const out = render(text);
    expect(out).toContain("::artifact-template");
    expect(out).not.toContain("reply-md-artifact-template");
  });

  test("without a handler the card is passive", () => {
    const out = render(TEMPLATE_CARD);
    expect(out).toContain("reply-md-artifact-template");
    expect(out).not.toContain("Use template");
  });

  test.each(parseModes)("with a handler the card offers Use template (parseRawHtml=%s)", (mode) => {
    const out = render(TEMPLATE_CARD, {
      parseRawHtml: mode,
      onUseArtifactTemplate: () => undefined,
    });
    expect(out).not.toContain("::artifact-template");
    expect(out).toContain('data-artifact-kind="document"');
    expect(out).toContain('data-markdown-copy="Hello World (Document template)\n\n"');
    expect(out).toContain('data-skill-name="artifact-template-hello-world"');
    expect(out).toContain("Document template");
    expect(out).toContain("Use template");
    expect(out).not.toContain("<p><div");
  });
});
