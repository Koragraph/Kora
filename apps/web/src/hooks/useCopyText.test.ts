import { CONTEXT_CHIP_CLIPBOARD_MIME } from "@kora/shared/contextChipClipboard";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  ClipboardApiUnavailableError,
  ClipboardReadError,
  ClipboardReadUnavailableError,
  ClipboardWriteError,
  readTextFromClipboard,
  writeTextToClipboard,
} from "./useCopyText";

type Written = { data: Record<string, Blob> };

/** Install the browser globals a test needs; anything omitted is simply absent. */
function browser(parts: {
  clipboard?: object | undefined;
  document?: object | undefined;
  items?: boolean;
}) {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", parts.clipboard ? { clipboard: parts.clipboard } : {});
  if ("document" in parts) vi.stubGlobal("document", parts.document);
  if (parts.items) {
    class ItemStub {
      constructor(readonly data: Record<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", ItemStub);
  }
}

const failure = async (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    (e: unknown) => e,
  );
const textOf = (call: unknown[], type: string) =>
  ((call[0] as Written[])[0]!.data[type] as Blob).text();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("writeTextToClipboard with the async Clipboard API", () => {
  test("uses writeText and never touches the textarea fallback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = vi.fn();
    browser({ clipboard: { writeText }, document: { execCommand } });

    await expect(writeTextToClipboard("ls -la", "command")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("ls -la");
    expect(execCommand).not.toHaveBeenCalled();
  });

  test.each([true, false])("empty text is a no-op (API present: %s)", async (present) => {
    const writeText = vi.fn();
    const execCommand = vi.fn();
    browser({ clipboard: present ? { writeText } : undefined, document: { execCommand } });

    const outcome = await writeTextToClipboard("", "plan");
    expect([outcome, writeText.mock.calls.length, execCommand.mock.calls.length]).toEqual([
      false,
      0,
      0,
    ]);
  });

  test("a rejected write surfaces as ClipboardWriteError with the cause, never the text", async () => {
    const cause = new Error("denied by browser");
    browser({ clipboard: { writeText: vi.fn().mockRejectedValue(cause) } });

    const error = await failure(writeTextToClipboard("top secret", "note"));

    expect(error).toBeInstanceOf(ClipboardWriteError);
    expect(error).toMatchObject({ cause, target: "note" });
    expect((error as Error).message).not.toContain("top secret");
  });

  test("extra flavors go in a ClipboardItem, but plain text can never be replaced by them", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    browser({ clipboard: { write, writeText: vi.fn() }, items: true });

    await expect(
      writeTextToClipboard("original", "message", {
        "text/html": "<b>original</b>",
        "text/plain": "impostor",
      }),
    ).resolves.toBe(true);

    expect(await textOf(write.mock.calls[0]!, "text/plain")).toBe("original");
    expect(await textOf(write.mock.calls[0]!, "text/html")).toBe("<b>original</b>");
  });

  test("a context fragment is embedded into the caller's rich HTML", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    browser({ clipboard: { write, writeText: vi.fn() }, items: true });
    const rich = "<p><strong>Hi</strong></p>";

    await writeTextToClipboard("Hi", "message", {
      "text/html": rich,
      [CONTEXT_CHIP_CLIPBOARD_MIME]: JSON.stringify({ version: 1, source: {}, records: [] }),
    });

    const html = await textOf(write.mock.calls[0]!, "text/html");
    expect(html).toContain(rich);
    expect(html).toContain("data-kora-context-fragment=");
  });

  test("when custom types are refused it retries with html only, then falls back to plain text", async () => {
    const write = vi.fn().mockRejectedValue(new Error("unsupported type"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    browser({ clipboard: { write, writeText }, items: true });

    await expect(
      writeTextToClipboard("body", "message", { "text/html": "<i>body</i>", "text/x-custom": "z" }),
    ).resolves.toBe(true);

    expect(write).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenCalledWith("body");
  });
});

describe("writeTextToClipboard without the async API", () => {
  function fakeTextarea() {
    return {
      value: "",
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      setSelectionRange: vi.fn(),
      select: vi.fn(),
      focus: vi.fn(),
      remove: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  }

  test.each(["success", "denied", "throws"] as const)(
    "the textarea fallback runs synchronously and cleans up after %s",
    async (outcome) => {
      const area = fakeTextarea();
      const append = vi.fn();
      const refocus = vi.fn();
      const execCommand = vi.fn(() => {
        if (outcome === "throws") throw new Error("exec failed");
        return outcome === "success";
      });
      browser({
        document: {
          execCommand,
          createElement: vi.fn(() => area),
          body: { appendChild: append },
          activeElement: { focus: refocus },
        },
      });

      const result = writeTextToClipboard("npm test", "command");
      // still inside the user gesture: no await has happened yet
      expect(execCommand).toHaveBeenCalledWith("copy");

      if (outcome === "success") await expect(result).resolves.toBe(true);
      else await expect(result).rejects.toBeInstanceOf(ClipboardApiUnavailableError);

      expect(area.value).toBe("npm test");
      expect(area.style.fontSize).toBe("16px");
      expect(append).toHaveBeenCalledWith(area);
      expect(area.focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(area.setSelectionRange).toHaveBeenCalledWith(0, "npm test".length);
      expect(area.remove).toHaveBeenCalledOnce();
      expect(refocus).toHaveBeenCalledOnce();
    },
  );

  test("with no document either, the error names the target but not the text", async () => {
    browser({ document: undefined });
    const error = await failure(writeTextToClipboard("plan body", "plan"));
    expect(error).toBeInstanceOf(ClipboardApiUnavailableError);
    expect(error).toMatchObject({ target: "plan" });
    expect((error as Error).message).not.toContain("plan body");
  });
});

describe("readTextFromClipboard", () => {
  test("returns what the browser gives", async () => {
    browser({ clipboard: { readText: vi.fn().mockResolvedValue("pasted") } });
    await expect(readTextFromClipboard()).resolves.toBe("pasted");
  });

  test("no readText means 'unavailable'", async () => {
    browser({ clipboard: {} });
    expect(await failure(readTextFromClipboard("input"))).toBeInstanceOf(
      ClipboardReadUnavailableError,
    );
  });

  test("a rejected read keeps its cause", async () => {
    const cause = new Error("no permission");
    browser({ clipboard: { readText: vi.fn().mockRejectedValue(cause) } });
    const error = await failure(readTextFromClipboard("input"));
    expect(error).toBeInstanceOf(ClipboardReadError);
    expect(error).toMatchObject({ cause, target: "input" });
  });
});
