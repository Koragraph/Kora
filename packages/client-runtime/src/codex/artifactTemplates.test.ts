import { describe, expect, it } from "vite-plus/test";

import * as Templates from "./artifactTemplates.ts";

const SKILL = "artifact-template-weekly-report";
const DOC: Templates.CodexArtifactTemplate = {
  artifactKind: "document",
  displayName: "Weekly report",
  skillName: SKILL,
  skillDirectory: `/home/dev/.codex/skills/${SKILL}`,
};

/** Template metadata the way Codex emits it (snake_case). */
const emitted = (overrides: Record<string, unknown> = {}) => ({
  artifact_kind: "document",
  display_name: "Weekly report",
  skill_name: SKILL,
  skill_directory: `/home/dev/.codex/skills/${SKILL}`,
  ...overrides,
});

describe("artifact templates", () => {
  it("labels a document template the same way on every client", () => {
    expect(Templates.codexArtifactTemplatePresentationLabel("document")).toBe("Document template");
  });

  describe("reading Codex metadata", () => {
    it("maps the fields and trims the display name", () => {
      expect(
        Templates.resolveCodexArtifactTemplate(emitted({ display_name: "\tWeekly report " })),
      ).toEqual(DOC);
    });

    it.each([
      String.raw`D:\Profiles\dev\.codex\skills\artifact-template-chart`,
      String.raw`\\fileserver\skills\artifact-template-chart`,
      "//fileserver/skills/artifact-template-chart",
    ])("accepts the absolute Windows directory %s", (skillDirectory) => {
      const template = Templates.resolveCodexArtifactTemplate(
        emitted({
          artifact_kind: "image",
          display_name: "Chart",
          gallery_kind: "product-design",
          skill_name: "artifact-template-chart",
          skill_directory: skillDirectory,
        }),
      );
      expect([template?.skillDirectory, template?.artifactKind, template?.galleryKind]).toEqual([
        skillDirectory,
        "image",
        "product-design",
      ]);
    });

    it.each([
      ["an unknown kind", { artifact_kind: "spreadsheet-ish" }],
      ["a blank name", { display_name: "   " }],
      ["a relative directory", { skill_directory: "skills/report" }],
      ["a skill name without the template prefix", { skill_name: "weekly-report" }],
      ["a null gallery kind", { gallery_kind: null }],
      ["an unknown gallery kind", { gallery_kind: "moodboard" }],
    ])("refuses %s", (_label, override) => {
      expect(Templates.resolveCodexArtifactTemplate(emitted(override))).toBeNull();
    });
  });

  describe("use prompt", () => {
    const prompt = `Create a document using this $${SKILL} about…`;

    it("follows Codex's wording for documents and images", () => {
      expect(Templates.codexArtifactTemplateUsePrompt(DOC)).toBe(prompt);
      expect(Templates.codexArtifactTemplateUsePrompt({ ...DOC, artifactKind: "image" })).toBe(
        `Create an image using this $${SKILL} of…`,
      );
    });

    it("fills an empty draft and appends to an existing one", () => {
      expect(Templates.appendCodexArtifactTemplateUsePrompt("", DOC)).toBe(prompt);
      expect(Templates.appendCodexArtifactTemplateUsePrompt("Cover Q3 numbers", DOC)).toBe(
        `Cover Q3 numbers ${prompt}`,
      );
    });

    it.each([prompt, `${prompt}\n`, `Context first\n\n${prompt}`])(
      "does not add it twice to %j",
      (draft) => {
        expect(Templates.appendCodexArtifactTemplateUsePrompt(draft, DOC)).toBe(draft);
      },
    );

    it("still appends when the prompt is followed by more text", () => {
      const draft = `${prompt}\nKeep it short.`;
      expect(Templates.appendCodexArtifactTemplateUsePrompt(draft, DOC)).toBe(`${draft} ${prompt}`);
    });
  });
});
