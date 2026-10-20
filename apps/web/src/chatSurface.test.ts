import { describe, expect, it } from "vite-plus/test";

import {
  isAssistantSurfaceProject,
  isBlobsSurfaceProject,
  isLegacyChatPath,
  landingProjectsForSurface,
  projectSurface,
} from "./chatSurface";

const repo = { id: "repo", surface: "code" as const };
const legacy: { id: string; surface?: "code" | "blobs" } = { id: "legacy" }; // no surface field = code
const kora = { id: "blob_kora", surface: "blobs" as const };
// A project cached from before the Chat surface was folded into Kora.
const oldChat = { id: "chat-general", surface: "chat" };

describe("landingProjectsForSurface (the `/` landing)", () => {
  it("the Code tab never lands in a blob, even when it is the most recent", () => {
    expect(landingProjectsForSurface([kora, repo, legacy], "code")).toEqual([repo, legacy]);
  });
  it("Code tab with only blobs → nothing (the open-a-project hero)", () => {
    expect(landingProjectsForSurface([kora], "code")).toEqual([]);
  });
  it("Kora lands only in blob projects; with none yet it has nowhere to land", () => {
    expect(landingProjectsForSurface([repo, kora], "blobs")).toEqual([kora]);
    expect(landingProjectsForSurface([repo], "blobs")).toEqual([]);
  });
});

describe("projectSurface", () => {
  it("is Kora for a blob project and Code for everything else", () => {
    expect(projectSurface(kora)).toBe("blobs");
    expect(projectSurface(repo)).toBe("code");
    expect(projectSurface(legacy)).toBe("code");
    expect(projectSurface(null)).toBe("code");
    expect(projectSurface(undefined)).toBe("code");
    expect(projectSurface({ surface: "something-newer" })).toBe("code");
  });
  it("a stale cached Chat project reads as Code (the Chat surface no longer exists)", () => {
    expect(projectSurface(oldChat)).toBe("code");
    expect(isAssistantSurfaceProject(oldChat)).toBe(false);
  });
  it("only a blob is an assistant-lane project", () => {
    expect(isBlobsSurfaceProject(kora)).toBe(true);
    expect(isAssistantSurfaceProject(kora)).toBe(true);
    expect(isAssistantSurfaceProject(repo)).toBe(false);
  });
});

describe("isLegacyChatPath (old Chat links redirect into Kora)", () => {
  it("matches /chat and anything under it", () => {
    expect(isLegacyChatPath("/chat")).toBe(true);
    expect(isLegacyChatPath("/chat/")).toBe(true);
    expect(isLegacyChatPath("/chat/projects/abc")).toBe(true);
    expect(isLegacyChatPath("/chats")).toBe(true);
  });
  it("leaves every real route alone", () => {
    for (const p of ["/", "/blobs", "/blobs/blob_kora", "/settings/chat", "/projects/h:p", "/h1/chatty", "/chatter"])
      expect(isLegacyChatPath(p)).toBe(false);
  });
});
