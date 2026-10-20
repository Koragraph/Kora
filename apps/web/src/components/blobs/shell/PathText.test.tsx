import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";

import { PathText, pathParts } from "./PathText";

describe("PathText", () => {
  it("breaks only at slashes (a <wbr> after each one) and shows ~", () => {
    expect(pathParts("/Users/sam/Blobs-Dev/Junip")).toEqual(["~", "Blobs-Dev", "Junip"]);
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(<PathText path="/Users/sam/Blobs-Dev/Junip" />);
    });
    const code = r.root.findByType("code");
    const flat = (n: ReactTestInstance): string =>
      n.children
        .map((c) => (typeof c === "string" ? c : c.type === "wbr" ? "|" : flat(c)))
        .join("");
    expect(flat(code)).toBe("~/|Blobs-Dev/|Junip");
    expect(code.props.className).toContain("[word-break:normal]");
  });
});
