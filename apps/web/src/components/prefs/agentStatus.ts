import type { AgentVersionAdvisory, AgentStatus } from "@kora/contracts";

export function getAgentSummary(provider: AgentStatus | undefined): {
  headline: string;
  detail: string | null;
} {
  if (!provider) {
    return {
      detail: "Checking whether it's installed and signed in.",
      headline: "Checking",
    };
  }
  const message = provider.message || null;
  if (!provider.enabled || provider.status === "disabled") {
    return {
      headline: "Disabled",
      detail: message ?? "Installed, but turned off for new chats in Kora.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: message ?? "Kora couldn't find its command-line tool.",
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return { headline: "Not signed in", detail: message };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail: message ?? "Installed, but Kora couldn't fully check it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: message ?? "It failed its start-up checks.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const account = provider.auth.label ?? provider.auth.type;
    return {
      headline: account ? `Authenticated · ${account}` : "Authenticated",
      detail: message,
    };
  }
  // A ready provider without account metadata is available, not an auth failure.
  return { headline: "Available", detail: message };
}

const ANTIGRAVITY_TAG = /^agy_acp_server_(\d{4})(\d{2})(\d{2})_\d+(?:_([A-Za-z]+))?$/;

export function getAgentVersionLabel(version: string | null | undefined): string | null {
  if (!version) return null;
  const tag = ANTIGRAVITY_TAG.exec(version);
  if (tag) {
    const [, year, month, day, suffix] = tag;
    return `${year}-${month}-${day}${suffix ? ` ${suffix}` : ""}`;
  }
  return /^\d/.test(version) ? `v${version}` : version;
}

export function getAgentVersionAdvisoryPresentation(advisory: AgentVersionAdvisory | undefined): {
  readonly emphasis: "normal" | "strong";
  readonly updateCommand: string | null;
  readonly detail: string;
} | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") return null;
  const latest = getAgentVersionLabel(advisory.latestVersion);
  const detail =
    advisory.message ||
    (latest
      ? `Update available: install ${latest}.`
      : "Update available: install the latest provider version.");
  return { detail, updateCommand: advisory.updateCommand ?? null, emphasis: "normal" };
}
