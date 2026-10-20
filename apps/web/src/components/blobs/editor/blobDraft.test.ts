import type { BlobDefaults, BlobProfile } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  editorDraftFromBlob,
  editorDraftFromBlobDraft,
  isEditorDraftDirty,
  newEditorDraft,
  toBlobDraft,
  toProfilePatch,
  validateEditorDraft,
} from "./blobDraft";

const defaults: BlobDefaults = { engine: null, permission: "auto", soulTemplate: "" };
const profile = {
  id: "blob_popo",
  name: "Popo",
  title: "Researcher",
  role: "member",
  engine: { instanceId: "claude", model: "sonnet", effort: null },
  permission: "auto",
  outfit: { head: "beret", face: null, neck: null },
  archivedAt: null,
} as unknown as BlobProfile;

describe("new blob draft", () => {
  it("starts with a funny free name, Auto, best-installed and a warm soul", () => {
    const d = newEditorDraft({ defaults, takenNames: ["Popo"], random: () => 0.1 });
    expect(d.name).not.toBe("Popo");
    expect(d.name.length).toBeGreaterThan(0);
    expect(d.permission).toBe("auto");
    expect(d.engine).toBeNull();
    expect(d.soul.length).toBeGreaterThan(20);
    expect(d.outfit.head).not.toBe("crown");
  });
  it("takes engine, permission and soul from the user's defaults", () => {
    const d = newEditorDraft({
      defaults: {
        engine: { instanceId: "codex", model: "gpt", effort: null },
        permission: "ask",
        soulTemplate: "Be terse.",
      },
      takenNames: [],
    });
    expect(d.engine?.instanceId).toBe("codex");
    expect(d.permission).toBe("ask");
    expect(d.soul).toBe("Be terse.");
  });
});

describe("discarding a draft", () => {
  it("an edited draft is dirty against the original; the untouched original is not", () => {
    const original = editorDraftFromBlob(profile, "soul");
    expect(isEditorDraftDirty(original, editorDraftFromBlob(profile, "soul"))).toBe(false);
    expect(isEditorDraftDirty({ ...original, name: "Popo 2" }, original)).toBe(true);
    expect(isEditorDraftDirty({ ...original, outfit: { head: "cap" } }, original)).toBe(true);
    // Cancel = throw the draft away: the persisted profile (and so a fresh draft from it) never changed.
    expect(editorDraftFromBlob(profile, "soul")).toEqual(original);
  });
});

describe("validation", () => {
  const blobs = [profile];
  it("requires a unique name", () => {
    const d = editorDraftFromBlob(profile, "s");
    expect(validateEditorDraft({ ...d, name: " " }, blobs, null).name).toBeTruthy();
    expect(validateEditorDraft({ ...d, name: "popo" }, blobs, null).name).toMatch(/already/);
    expect(validateEditorDraft({ ...d, name: "popo" }, blobs, "blob_popo").name).toBeUndefined();
  });
});

describe("apps grants in the editor", () => {
  const withGrants = {
    ...profile,
    toolGrants: {
      apps: { mode: "none", allow: [] },
      mcp: ["x"],
      computer: { browser: true, vm: false },
    },
  } as unknown as BlobProfile;
  it("a new or tweaked blob starts with no apps; the profile's own grants load into the draft", () => {
    expect(newEditorDraft({ defaults, takenNames: [] }).apps).toEqual({ mode: "none", allow: [] });
    expect(
      editorDraftFromBlob(
        {
          ...withGrants,
          toolGrants: {
            ...withGrants.toolGrants,
            apps: { mode: "list", allow: ["toolkit:gmail"] },
          },
        },
        "s",
      ).apps,
    ).toEqual({ mode: "list", allow: ["toolkit:gmail"] });
    expect(editorDraftFromBlob(profile, "s").apps).toEqual({ mode: "none", allow: [] }); // an old profile with no toolGrants at all
  });
  it("changing the grants is a change (dirty) and a patch that keeps the rest of the grants as they were", () => {
    const original = editorDraftFromBlob(withGrants, "s");
    const next = { ...original, apps: { mode: "list" as const, allow: ["toolkit:gmail"] } };
    expect(isEditorDraftDirty(next, original)).toBe(true);
    expect(toProfilePatch(original, next, withGrants.toolGrants)).toEqual({
      toolGrants: {
        apps: { mode: "list", allow: ["toolkit:gmail"] },
        mcp: ["x"],
        computer: { browser: true, vm: false },
      },
    });
    // the order of entries is not a change
    const a = { ...original, apps: { mode: "list" as const, allow: ["toolkit:a", "toolkit:b"] } };
    const b = { ...original, apps: { mode: "list" as const, allow: ["toolkit:b", "toolkit:a"] } };
    expect(isEditorDraftDirty(a, b)).toBe(false);
    expect(toProfilePatch(a, b, withGrants.toolGrants)).toEqual({});
  });
});

describe("save payloads", () => {
  it("create sends a full wire draft with every outfit slot", () => {
    const wire = toBlobDraft({ ...editorDraftFromBlob(profile, " be nice "), title: " Scout " });
    expect(wire).toMatchObject({
      name: "Popo",
      title: "Scout",
      soul: "be nice",
      outfit: { head: "beret", face: null, neck: null },
      templateId: null,
    });
  });
  it("update sends only what changed", () => {
    const original = editorDraftFromBlob(profile, "s");
    expect(toProfilePatch(original, original)).toEqual({});
    expect(toProfilePatch(original, { ...original, permission: "full", title: "Scout" })).toEqual({
      permission: "full",
      title: "Scout",
    });
  });
});

describe("Tweak: a proposal draft opens the editor and comes back whole", () => {
  const proposal = {
    name: "Tiki",
    title: "Refund Watcher",
    job: "Watches Shopify orders and pings you about refunds",
    howItWorks: ["Checks hourly"],
    soul: "You are Tiki.",
    engine: null,
    permission: "ask" as const,
    outfit: { head: "beanie", face: null, neck: null },
    apps: ["shopify"],
    skills: ["refund-triage"],
    routines: [{ title: "Daily digest", cadence: "Weekdays 17:00" }],
    templateId: null,
  };
  it("prefills name, title, soul, look, model and permission", () => {
    const d = editorDraftFromBlobDraft(proposal);
    expect(d).toMatchObject({
      name: "Tiki",
      title: "Refund Watcher",
      soul: "You are Tiki.",
      permission: "ask",
      engine: null,
    });
    expect(d.outfit.head).toBe("beanie");
  });
  it("saving keeps what the editor does not show (job, how it works, apps, skills, routines)", () => {
    const edited = {
      ...editorDraftFromBlobDraft(proposal),
      name: "Tiki Two",
      permission: "auto" as const,
    };
    const out = toBlobDraft(edited, proposal);
    expect(out).toMatchObject({
      name: "Tiki Two",
      permission: "auto",
      job: proposal.job,
      howItWorks: proposal.howItWorks,
      apps: ["shopify"],
      skills: ["refund-triage"],
      routines: proposal.routines,
    });
    expect(out.outfit).toEqual({ head: "beanie", face: null, neck: null });
    // without a base nothing changes for a brand-new blob
    expect(toBlobDraft(edited).routines).toEqual([]);
  });
});

describe("free helpers (per-blob switch, on by default)", () => {
  it("a new blob, a proposal's tweak and a profile with no setting all start with helpers on", () => {
    expect(newEditorDraft({ defaults, takenNames: [], random: () => 0.3 }).helpers).toBe(true);
    expect(editorDraftFromBlob(profile, "soul").helpers).toBe(true);
  });
  it("a blob switched off reads off, and flipping it is a dirty one-field patch", () => {
    const off = { ...profile, helpers: false } as unknown as BlobProfile;
    const original = editorDraftFromBlob(off, "soul");
    expect(original.helpers).toBe(false);
    const on = { ...original, helpers: true };
    expect(isEditorDraftDirty(on, original)).toBe(true);
    expect(toProfilePatch(original, on)).toEqual({ helpers: true });
    expect(toProfilePatch(original, original)).toEqual({});
  });
});
