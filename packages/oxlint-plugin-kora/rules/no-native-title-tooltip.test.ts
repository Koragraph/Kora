import { expect } from "vite-plus/test";

import { lintRule } from "../test/utils.ts";

const rule = lintRule("kora/no-native-title-tooltip", { filename: "view.tsx" });

rule.allows("a plain element with no title", `export const A = <div className="flex">hi</div>;`);
rule.allows("a title prop on our own component", `export const A = <SettingsRow title="Theme" />;`);
rule.allows("a title on a namespaced component", `export const A = <Ui.Card title="Plan" />;`);
rule.allows("an iframe's accessible name", `export const A = <iframe title="Preview" src="/x" />;`);
rule.allows(
  "an embed's accessible name",
  `export const A = <embed title="Report" src="/r.pdf" />;`,
);
rule.allows("an svg <title> child", `export const A = <svg><title>Logo</title></svg>;`);
rule.allows("setting the document's title", `document.title = "Kora";`);

rule.reports(
  "a hover title on a label that truncates",
  `export const A = <span className="truncate" title={fullName}>{fullName}</span>;`,
  (output) => expect(output).toContain("Tooltip + TooltipTrigger + TooltipPopup"),
);
rule.reports("a title on a button", `export const A = <button type="button" title="Close" />;`);
rule.reports("a title on a link", `export const A = <a href="/docs" title="Docs">Docs</a>;`);
rule.reports("a title on inline code", `export const A = <code title={path}>{path}</code>;`);
