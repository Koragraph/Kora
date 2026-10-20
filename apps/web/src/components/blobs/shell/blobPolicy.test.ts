import { describe, expect, it } from "vite-plus/test";

import { blobPromptPlaceholder } from "../../../promptPlaceholder";
import { blobAccessMode } from "./blobPosture";
import { blobsRootLabel, newBlobFolderLabel, tildify } from "./blobsRoot";
import { deleteConfirmMatches } from "./DeleteBlobDialog";
import { engineLabel } from "./engineLabel";
import { paidBlobIdsOf, shouldWarnConcurrency, withoutRecoveredFailures } from "./blobStatus";

describe("blobAccessMode (the composer shows the blob's real posture)", () => {
  it("maps Ask / Auto / Full per engine", () => {
    expect(blobAccessMode("ask", "claude")).toBe("approval-required");
    expect(blobAccessMode("full", "codex")).toBe("full-access");
    expect(blobAccessMode("auto", "claude")).toBe("auto");
    expect(blobAccessMode("auto", "claude:work")).toBe("auto");
    expect(blobAccessMode("auto", "codex")).toBe("auto-accept-edits");
    expect(blobAccessMode("auto", "opencode")).toBe("auto-accept-edits");
  });
});

describe("engineLabel", () => {
  it("uses the picker's name when the catalog knows the model, never 'Claude · default'", () => {
    const catalog = () => [
      { slug: "sonnet", name: "Sonnet 5.5" },
      { slug: "default", name: "Default (Sonnet 5.5)" },
    ];
    expect(engineLabel({ instanceId: "claude", model: "sonnet" }, catalog)).toBe("Sonnet 5.5");
    expect(engineLabel({ instanceId: "claude", model: "sonnet" })).toBe("Claude Sonnet");
    expect(engineLabel({ instanceId: "claude", model: "default" })).toBe("Claude");
    expect(engineLabel({ instanceId: "opencode", model: "opencode/big-pickle:free" })).toBe(
      "Big Pickle · free",
    );
  });
});

describe("blobsRoot", () => {
  it("shows the real folder, not a hard-coded ~/Blobs", () => {
    const blobs = [{ workspace: "/Users/me/Blobs-Dev/kora" }];
    expect(blobsRootLabel(blobs)).toBe("~/Blobs-Dev");
    expect(newBlobFolderLabel(blobs, " Popo ")).toBe("~/Blobs-Dev/Popo");
    expect(newBlobFolderLabel([], "")).toBe("~/Blobs/…");
    expect(tildify("/Users/me/Blobs/popo")).toBe("~/Blobs/popo");
    expect(tildify("/srv/blobs/popo")).toBe("/srv/blobs/popo");
  });
});

describe("concurrency warning", () => {
  const ids = (...a: string[]) => new Set(a);
  it("counts only blobs on a paid plan; a free blob neither triggers nor adds", () => {
    const paid = paidBlobIdsOf([
      { id: "a", engine: { instanceId: "claude" } },
      { id: "b", engine: { instanceId: "codex" } },
      { id: "c", engine: { instanceId: "claude" } },
      { id: "f", engine: { instanceId: "opencode" } },
    ]);
    const base = { dismissed: false, paidBlobIds: paid };
    expect(
      shouldWarnConcurrency({ ...base, workingBlobIds: ids("a", "b"), startingBlobId: "c" }),
    ).toBe(true);
    expect(
      shouldWarnConcurrency({ ...base, workingBlobIds: ids("a", "b"), startingBlobId: "f" }),
    ).toBe(false);
    expect(
      shouldWarnConcurrency({ ...base, workingBlobIds: ids("a", "f"), startingBlobId: "c" }),
    ).toBe(false);
    expect(
      shouldWarnConcurrency({
        ...base,
        workingBlobIds: ids("a", "b"),
        startingBlobId: "c",
        dismissed: true,
      }),
    ).toBe(false);
  });
});

describe("roster status recovers", () => {
  const d = (tone: string) => ({ tone }) as never;
  it("drops a failed thread once a newer one went fine; keeps it when nothing recovered", () => {
    expect(withoutRecoveredFailures([d("idle"), d("failed")]).map((x) => x.tone)).toEqual(["idle"]);
    expect(withoutRecoveredFailures([d("failed"), d("idle")]).map((x) => x.tone)).toEqual([
      "failed",
      "idle",
    ]);
    expect(withoutRecoveredFailures([d("approval"), d("failed")]).map((x) => x.tone)).toEqual([
      "approval",
      "failed",
    ]);
  });
});

describe("delete confirm + composer placeholder", () => {
  it("needs the exact name", () => {
    expect(deleteConfirmMatches(" Popo ", "Popo")).toBe(true);
    expect(deleteConfirmMatches("popo", "Popo")).toBe(false);
    expect(deleteConfirmMatches("", "")).toBe(false);
  });
  it("names the blob; Kora is asked to plan", () => {
    expect(blobPromptPlaceholder({ name: "Popo", chief: false }, true)).toBe("Message Popo…");
    expect(blobPromptPlaceholder({ name: "Kora", chief: true }, true)).toBe(
      "Ask Kora to plan something…",
    );
    expect(blobPromptPlaceholder({ name: "Kora", chief: true }, false)).toBe("Message Kora…");
  });
});
