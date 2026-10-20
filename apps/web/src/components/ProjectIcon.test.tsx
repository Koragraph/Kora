import type { HostId } from "@kora/contracts";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("react", async (original) => {
  const { hookStub } = await import("~/test/hookStub");
  return { ...(await original<typeof import("react")>()), useState: hookStub.useState };
});
vi.mock("react/compiler-runtime", async () => ({
  c: (await import("~/test/hookStub")).hookStub.useMemoCache,
}));
vi.mock("lucide-react/dynamic", () => ({
  iconNames: ["alarm-clock", "folder-code"],
  DynamicIcon: "dynamic-icon",
}));

import { hookStub } from "~/test/hookStub";

import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectIcon";

const project = (
  over: Partial<ProjectFaviconProject> & Pick<ProjectFaviconProject, "title" | "workspaceRoot">,
): ProjectFaviconProject => ({ hostId: "host-under-test" as HostId, ...over });

/** Call the component as a function and look at the element it returns. */
const draw = <Props,>(p: ProjectFaviconProject) => {
  hookStub.startRender();
  return ProjectFavicon({ project: p }) as ReactElement<Props>;
};

beforeEach(() => hookStub.clear());

describe("ProjectFavicon", () => {
  test("a saved emoji wins over a favicon file", () => {
    const el = draw<{ emoji: string }>(
      project({
        title: "t",
        workspaceRoot: "/w/t",
        faviconPath: "brand/icon.svg",
        projectIcon: { kind: "emoji", emoji: "🦄" },
      }),
    );
    expect(el.props.emoji).toBe("🦄");
  });

  test("a saved Lucide icon wins over a favicon file and colours both wrapper and glyph", () => {
    type Tree = {
      className: string;
      children: ReactElement<{
        children: ReactElement<{ name: string; className: string }>;
      }>;
    };
    const el = draw<Tree>(
      project({
        title: "t",
        workspaceRoot: "/w/t",
        faviconPath: "brand/icon.svg",
        projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
      }),
    );
    const glyph = el.props.children.props.children.props;
    expect(glyph.name).toBe("alarm-clock");
    expect(el.props.className).toContain("text-violet-600");
    expect(glyph.className).toContain("text-violet-600");
  });

  test.each(["agent-runtime", "analytics-db"])(
    "without an icon the monogram uses the title %s",
    (title) => {
      const el = draw<{ projectName?: string }>(project({ title, workspaceRoot: `/w/${title}` }));
      expect(el.props.projectName).toBe(title);
    },
  );
});
