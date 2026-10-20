export function formatAppDisplayName(args: {
  readonly stageLabel: string;
  readonly baseName: string;
}): string {
  // The shipped app is just "Kora"; a Dev build carries a suffix.
  const stage = args.stageLabel.trim().toLowerCase();
  if (stage === "latest" || stage === "alpha") {
    return args.baseName;
  }

  return `${args.baseName} (${args.stageLabel})`;
}

/**
 * The window/tab title for a route: `<page> · <app>` on a thread ("Fix login bug · Kora") or
 * Settings, just the app name (with its stage suffix, e.g. "Kora (Dev)") on the draft landing.
 */
export function formatDocumentTitle(args: {
  readonly appDisplayName: string;
  readonly pathname: string;
  readonly threadTitle: string | null | undefined;
}): string {
  const threadTitle = args.threadTitle?.trim();
  if (threadTitle) return `${threadTitle} · ${args.appDisplayName}`;
  if (args.pathname === "/settings" || args.pathname.startsWith("/settings/")) {
    return `Settings · ${args.appDisplayName}`;
  }
  return args.appDisplayName;
}
