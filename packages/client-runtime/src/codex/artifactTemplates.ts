export type CodexArtifactTemplateKind =
  | "document"
  | "presentation"
  | "spreadsheet"
  | "site"
  | "google-docs"
  | "google-slides"
  | "google-sheets"
  | "image"
  | "email"
  | "slack";

export type CodexArtifactTemplateGalleryKind = "imagegen" | "product-design";

export interface CodexArtifactTemplate {
  readonly skillName: string;
  readonly skillDirectory: string;
  readonly galleryKind?: CodexArtifactTemplateGalleryKind;
  readonly displayName: string;
  readonly artifactKind: CodexArtifactTemplateKind;
}

export type CodexArtifactTemplateAttributes = Readonly<Record<string, string | null | undefined>>;

const KIND_LABELS: Readonly<Record<CodexArtifactTemplateKind, string>> = {
  slack: "Slack template",
  email: "Email template",
  image: "Image template",
  "google-sheets": "Google Sheet template",
  "google-slides": "Google Slides template",
  "google-docs": "Google Doc template",
  site: "Site template",
  spreadsheet: "Spreadsheet template",
  presentation: "Presentation template",
  document: "Document template",
};

const GALLERY_KINDS: ReadonlySet<string> = new Set(["imagegen", "product-design"]);
const SKILL_NAME_PREFIX = "artifact-template-";

const isKind = (value: string | null | undefined): value is CodexArtifactTemplateKind =>
  typeof value === "string" && Object.hasOwn(KIND_LABELS, value);

/** POSIX absolute (a single leading slash), a drive path, or a UNC path. */
const isAbsolutePath = (path: string): boolean =>
  (path.startsWith("/") && !path.startsWith("//")) ||
  /^[A-Za-z]:[\\/]/.test(path) ||
  /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(path);

/** Mirrors Codex's result-card schema; anything that does not fit stays literal Markdown. */
type MaybeAttributes = CodexArtifactTemplateAttributes | null | undefined;

export function resolveCodexArtifactTemplate(
  attributes: MaybeAttributes,
): CodexArtifactTemplate | null {
  if (!attributes) return null;
  const {
    artifact_kind: kind,
    display_name: displayName,
    skill_directory: skillDirectory,
    skill_name: skillName,
    gallery_kind: galleryKind,
  } = attributes;

  if (!isKind(kind)) return null;
  if (typeof displayName !== "string" || displayName.trim().length === 0) return null;
  if (typeof skillDirectory !== "string" || !isAbsolutePath(skillDirectory)) return null;
  if (typeof skillName !== "string" || !skillName.startsWith(SKILL_NAME_PREFIX)) return null;
  if (
    galleryKind !== undefined &&
    !(typeof galleryKind === "string" && GALLERY_KINDS.has(galleryKind))
  ) {
    return null;
  }

  return {
    artifactKind: kind,
    displayName: displayName.trim(),
    ...(galleryKind === undefined
      ? {}
      : { galleryKind: galleryKind as CodexArtifactTemplateGalleryKind }),
    skillDirectory,
    skillName,
  };
}

export function codexArtifactTemplatePresentationLabel(kind: CodexArtifactTemplateKind): string {
  return KIND_LABELS[kind];
}

export function codexArtifactTemplateUsePrompt(template: CodexArtifactTemplate): string {
  const skill = `$${template.skillName}`;
  switch (template.artifactKind) {
    case "document":
      return `Create a document using this ${skill} about…`;
    case "presentation":
      return `Create a presentation using the ${skill} template about…`;
    case "spreadsheet":
      return `Create a spreadsheet using this ${skill} about…`;
    case "site":
      return `Create a Site using this ${skill} about…`;
    case "google-docs":
      return `Create a Google Doc using this ${skill} about…`;
    case "google-slides":
      return `Create a Google Slides presentation using this ${skill} about…`;
    case "google-sheets":
      return `Create a Google Sheet using this ${skill} about…`;
    case "image":
      return `Create an image using this ${skill} of…`;
    case "email":
      return `Draft an email using this ${skill} about…`;
    case "slack":
      return `Draft a Slack message using this ${skill} about…`;
  }
}

/** Add the prompt to a draft unless the draft already ends with it. */
export function appendCodexArtifactTemplateUsePrompt(
  text: string,
  chosen: CodexArtifactTemplate,
): string {
  const prompt = codexArtifactTemplateUsePrompt(chosen);
  const body = text.trimEnd();
  // Already there as its own final word group (start of draft, or after whitespace)?
  const before = body.length - prompt.length - 1;
  const alreadyEnds = body.endsWith(prompt) && (before < 0 || /\s/.test(body.charAt(before)));
  if (alreadyEnds) return text;
  const needsSpace = text !== "" && !/\s$/.test(text);
  return text + (needsSpace ? " " : "") + prompt;
}
