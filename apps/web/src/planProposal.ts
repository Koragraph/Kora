const HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*$/;
const HEADING_ANYWHERE = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*$/m;
const DEFAULT_PREVIEW_LINES = 8;
const IMPLEMENT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

export function planProposalTitle(planText: string): string | null {
  const str = HEADING_ANYWHERE.exec(planText)?.[1]?.trim();
  return str ? str : null;
}

export function stripDisplayedPlanMarkdown(planText: string): string {
  const lines = planText.trimEnd().split(/\r?\n/);
  if (lines.length > 0 && HEADING.test(lines[0]!)) lines.shift();
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  // A leading "Summary" heading only restates what the card already shows.
  if (lines.length > 0 && HEADING.exec(lines[0]!)?.[1]?.trim().toLowerCase() === "summary") {
    lines.shift();
    while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  }
  return lines.join("\n");
}

export function buildCollapsedPlanProposalPreviewMarkdown(
  planText: string,
  opts?: { maxLines?: number },
): string {
  const maxLines = opts?.maxLines ?? DEFAULT_PREVIEW_LINES;
  const retained: string[] = [];
  let shown = 0;
  let truncated = false;

  for (const unparsed of stripDisplayedPlanMarkdown(planText).split("\n")) {
    const ln = unparsed.trimEnd();
    if (ln.trim() !== "") {
      if (shown >= maxLines) {
        truncated = true;
        break;
      }
      shown += 1;
    }
    retained.push(ln);
  }
  while (retained.length > 0 && retained[retained.length - 1]!.trim() === "") retained.pop();

  if (retained.length === 0) return planProposalTitle(planText) ?? "Plan preview unavailable.";
  return truncated ? [...retained, "", "..."].join("\n") : retained.join("\n");
}

export const buildPlanImplementationPrompt = (planText: string): string =>
  `${IMPLEMENT_PREFIX}${planText.trim()}`;

export function resolvePlanFollowUpSubmission(args: { draftText: string; planMarkdown: string }): {
  text: string;
  interactionMode: "default" | "plan";
} {
  const feedback = args.draftText.trim();
  return feedback.length > 0
    ? { text: feedback, interactionMode: "plan" }
    : { text: buildPlanImplementationPrompt(args.planMarkdown), interactionMode: "default" };
}

export function buildPlanImplementationThreadTitle(planText: string): string {
  const heading = planProposalTitle(planText);
  return heading ? `Implement ${heading}` : "Implement plan";
}

export function buildPlanProposalMarkdownFilename(planText: string): string {
  const idSlug = (planProposalTitle(planText) ?? "plan")
    .toLowerCase()
    .replace(/[`"'.,!?()[\]{}]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${idSlug || "plan"}.md`;
}

export const normalizePlanMarkdownForExport = (planText: string): string =>
  `${planText.trimEnd()}\n`;

export function downloadPlanAsTextFile(filename: string, inner: string): void {
  const address = URL.createObjectURL(new Blob([inner], { type: "text/markdown;charset=utf-8" }));
  const anch = document.createElement("a");
  anch.href = address;
  anch.download = filename;
  anch.click();
  setTimeout(() => URL.revokeObjectURL(address), 0);
}
