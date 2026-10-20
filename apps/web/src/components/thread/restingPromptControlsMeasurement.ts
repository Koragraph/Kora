import type { RestingPromptControlsMeasurement } from "../promptFooterLayout";

const px = (value: string | undefined): number => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** Rendered width plus inline margins; an element that is not rendered counts as 0. */
function outerWidth(element: Element): number {
  const width = element.getBoundingClientRect().width;
  if (width === 0) {
    return 0;
  }
  const style = getComputedStyle(element);
  return width + px(style.marginInlineStart) + px(style.marginInlineEnd);
}

/**
 * Reads the natural widths of the composer's resting control row from the DOM, so the composer and the
 * context strip decide from the same numbers. Hidden blocks stay mounted out of flow at full size.
 */
export function measureRestingPromptControls(
  controls: HTMLElement,
): RestingPromptControlsMeasurement | null {
  const gap = px(getComputedStyle(controls).columnGap);

  const picker = controls.querySelector<HTMLElement>("[data-agent-model-picker]");
  const leading = picker ?? controls.querySelector<HTMLElement>('[data-agent-unavailable="true"]');
  if (!leading) return null;

  const separator = controls.querySelector("[data-resting-controls-separator]");
  const separatorWidth = separator ? outerWidth(separator) : 0;
  const separatorAndGap = separatorWidth > 0 ? separatorWidth + gap : 0;

  const overflow = controls.querySelector("[data-resting-controls-overflow]");
  const overflowWidth = overflow ? outerWidth(overflow) : 0;

  const blockWidths = Array.from(controls.querySelectorAll("[data-resting-block]")).map(outerWidth);

  let naturalLeading: number;
  let minimumLeading: number;
  if (picker) {
    const style = getComputedStyle(picker);
    const margins = px(style.marginInlineStart) + px(style.marginInlineEnd);
    const rendered = picker.getBoundingClientRect().width;

    let hiddenLabelWidth = 0;
    const label = picker.querySelector<HTMLElement>('[data-agent-model-picker-label="true"]');
    if (rendered > 0 && label) {
      const collapsed = label.clientWidth === 0 && px(getComputedStyle(label).flexGrow) === 0;
      if (!collapsed) hiddenLabelWidth = Math.max(0, label.scrollWidth - label.clientWidth);
    }
    const maxWidth = Number.parseFloat(style.maxWidth);
    const widthWithLabel = rendered === 0 ? 0 : rendered + hiddenLabelWidth;
    naturalLeading =
      (Number.isFinite(maxWidth) ? Math.min(widthWithLabel, maxWidth) : widthWithLabel) + margins;
    minimumLeading = px(style.minWidth) + margins;
  } else {
    naturalLeading = outerWidth(leading);
    minimumLeading = naturalLeading;
  }

  return {
    gap,
    naturalFixedWidth: naturalLeading + separatorAndGap,
    minimumFixedWidth: minimumLeading + separatorAndGap,
    blockWidths,
    overflowWidth,
  };
}
