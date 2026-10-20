import * as Schema from "effect/Schema";

const DiffSide = Schema.Literals(["additions", "deletions"]);

export const ReviewCommentContextSchema = Schema.Struct({
  selection: Schema.optional(
    Schema.Struct({
      start: Schema.Number,
      side: DiffSide,
      end: Schema.Number,
      endSide: DiffSide,
    }),
  ),
  fenceLanguage: Schema.optional(Schema.String),
  diff: Schema.String,
  text: Schema.String,
  rangeLabel: Schema.String,
  endIndex: Schema.Number,
  startIndex: Schema.Number,
  filePath: Schema.String,
  sectionTitle: Schema.String,
  sectionId: Schema.String,
  id: Schema.String,
});

export interface ReviewCommentContext {
  readonly selection?:
    | {
        readonly start: number;
        readonly side: "additions" | "deletions";
        readonly end: number;
        readonly endSide: "additions" | "deletions";
      }
    | undefined;
  readonly fenceLanguage?: string | undefined;
  readonly diff: string;
  readonly text: string;
  readonly rangeLabel: string;
  readonly endIndex: number;
  readonly startIndex: number;
  readonly filePath: string;
  readonly sectionTitle: string;
  readonly sectionId: string;
  readonly id: string;
}

/** Markdown fence that cannot be closed by backticks inside `contents`. */
export function inferReviewCommentFenceLanguage(filePath: string): string {
  const label = (filePath.replaceAll("\\", "/").split("/").pop() ?? "").toLowerCase();
  const dot = label.lastIndexOf(".");
  if (dot > 0 && dot < label.length - 1) return label.slice(dot + 1);
  if (label.startsWith(".") && label.length > 1) return label.slice(1);
  return "text";
}

export function buildFileReviewComment(args: {
  contents: string;
  text: string;
  endLine: number;
  startLine: number;
  filePath: string;
  id: string;
}): ReviewCommentContext {
  const first = Math.max(1, Math.min(args.startLine, args.endLine));
  const last = Math.max(first, Math.max(args.startLine, args.endLine));
  const covered = args.contents.split("\n").slice(first - 1, last);
  return {
    fenceLanguage: inferReviewCommentFenceLanguage(args.filePath),
    diff: covered.join("\n"),
    text: args.text.trim(),
    rangeLabel: first === last ? `L${first}` : `L${first} to L${last}`,
    endIndex: last - 1,
    startIndex: first - 1,
    filePath: args.filePath,
    sectionTitle: "File comment",
    sectionId: `file:${args.filePath}`,
    id: args.id,
  };
}

export function buildReviewCommentRenderablePatch(remark: ReviewCommentContext): string {
  if ((remark.fenceLanguage ?? "diff") !== "diff") return "";
  const diff = remark.diff.trim();
  if (diff === "") return "";
  if (diff.startsWith("diff --git ")) return diff;
  const loc = remark.filePath.replaceAll("\\", "/");
  return [`diff --git a/${loc} b/${loc}`, `--- a/${loc}`, `+++ b/${loc}`, diff].join("\n");
}
