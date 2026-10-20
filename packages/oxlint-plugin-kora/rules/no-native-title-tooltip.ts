import { defineRule } from "@oxlint/plugins";

const LOWERCASE_TAG = /^[a-z]/u;

// On these elements the title attribute names the embedded content for
// accessibility (and does not reliably produce a hover tooltip), so the styled
// Tooltip component is not a drop-in replacement.
const TITLE_IS_AN_ACCESSIBLE_NAME = new Set(["object", "math", "iframe", "frame", "embed"]);

const TOOLTIP_MESSAGE =
  "Do not use the native title attribute as a tooltip. Use Tooltip + TooltipTrigger + TooltipPopup from components/ui/tooltip.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the native title attribute as a tooltip on intrinsic elements; use the styled Tooltip component.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const tag = node.name;
        if (tag.type !== "JSXIdentifier") return;
        if (!LOWERCASE_TAG.test(tag.name) || TITLE_IS_AN_ACCESSIBLE_NAME.has(tag.name)) return;

        const titles = node.attributes.filter(
          (attribute) =>
            attribute.type === "JSXAttribute" &&
            attribute.name.type === "JSXIdentifier" &&
            attribute.name.name === "title",
        );
        for (const attribute of titles) {
          context.report({ node: attribute, message: TOOLTIP_MESSAGE });
        }
      },
    };
  },
});
