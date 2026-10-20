/**
 * Kora on GitHub. Two repositories with different jobs:
 *  - the source repository (code, guide, issues): Koragraph/Kora;
 *  - the releases repository (signed builds and the auto-update feed): agilkatakam/kora. scripts/release-app.sh
 *    publishes there (its KORA_PUBLIC_REPO default), and installed apps update from it: keep the two in step.
 */
const KORA_SOURCE_REPO = "Koragraph/Kora";
export const KORA_SOURCE_REPO_URL = `https://github.com/${KORA_SOURCE_REPO}`;
const KORA_RELEASES_REPO = "agilkatakam/kora";
export const KORA_RELEASES_REPO_URL = `https://github.com/${KORA_RELEASES_REPO}`;
const KORA_RELEASES_URL = `${KORA_RELEASES_REPO_URL}/releases`;

export interface BugReportContext {
  /** The app version, e.g. "0.2.0". */
  readonly appVersion: string;
  /** The bundled runtime's build id (version-commit-timestamp), when known. */
  readonly build?: string | null;
  /** e.g. "macOS 26.0". */
  readonly os?: string | null;
  /** e.g. "arm64". */
  readonly arch?: string | null;
}

/**
 * A new-issue URL for the bug form (.github/ISSUE_TEMPLATE/bug_report.yml in the source repo) with the version and
 * macOS fields filled in. Only build facts go in the URL — never paths, user names or anything from a thread.
 */
export function bugReportUrl(context: BugReportContext): string {
  const version = context.build ? `${context.appVersion} (${context.build})` : context.appVersion;
  const system = [context.os, context.arch].filter((part) => part && part.length > 0).join(", ");
  const params = new URLSearchParams({ template: "bug_report.yml", version });
  if (system.length > 0) params.set("macos", system);
  return `${KORA_SOURCE_REPO_URL}/issues/new?${params.toString()}`;
}

/** The release page for one version (`v<version>` tags), or the list when the version is unknown. */
export function releaseNotesUrl(version: string | null): string {
  return version ? `${KORA_RELEASES_URL}/tag/v${version}` : KORA_RELEASES_URL;
}
