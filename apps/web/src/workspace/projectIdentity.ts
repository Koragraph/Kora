import { PROJECT_ICON_COLORS } from "../appearance/projectIconColors";
import type { ProjectBadgeColor } from "@kora/contracts";

/** Visual identity tokens for a generated project badge. */
export interface ProjectIdentity {
  readonly monogram: string;
  readonly color: ProjectBadgeColor;
}

const normalizeProjectName = (projectName: string): string => projectName.normalize("NFKC").trim();

function projectMonogram(projectName: string): string {
  const words = normalizeProjectName(projectName).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words[0]) return "PR";

  const glyphs = Array.from(words[0]);
  const head = glyphs[0] ?? "P";
  const firstDigit = glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph));
  const lastWordInitial = words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1);
  const second = firstDigit ?? lastWordInitial ?? head;
  return Array.from((head + second).toUpperCase())
    .slice(0, 2)
    .join("");
}

function projectColor(projectName: string): ProjectBadgeColor {
  const seed = normalizeProjectName(projectName).toLocaleLowerCase("en-US") || "project";
  let pos = 0;
  for (const glyph of seed) {
    pos = (pos * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_ICON_COLORS.length;
  }
  return PROJECT_ICON_COLORS[pos]?.value ?? "blue";
}

/** Derives the stable monogram and generated colors used when a project has no icon. */
export function deriveProjectIdentity(projectName: string): ProjectIdentity {
  const color = projectColor(projectName);
  return { color, monogram: projectMonogram(projectName) };
}
