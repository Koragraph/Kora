import {
  projectIconColorClassName,
  firstEmoji,
  filterProjectIconNames,
} from "./projectIconOptions";
import { describe, expect, it } from "vite-plus/test";

describe("projectIconOptions", () => {
  it("maps persisted colors to theme-aware classes", () => {
    expect(projectIconColorClassName("violet")).toBe("text-violet-600 dark:text-violet-400");
  });

  it("extracts one complete emoji grapheme", () => {
    expect(firstEmoji("  👩🏽‍💻 hello")).toBe("👩🏽‍💻");
    expect(firstEmoji("🇺🇸 project")).toBe("🇺🇸");
    expect(firstEmoji("1️⃣ project")).toBe("1️⃣");
    expect(firstEmoji("plain text")).toBeNull();
  });
  it("searches across the full Lucide set", () => {
    expect(filterProjectIconNames("alarm clock")).toContain("alarm-clock");
    expect(filterProjectIconNames("alarm  \tclock")).toContain("alarm-clock");
  });
});
