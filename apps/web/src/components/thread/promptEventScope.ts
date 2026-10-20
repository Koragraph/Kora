import { usePromptHandleContext } from "../../promptHandleContext";

const PROMPT_FLOATING_LAYER_SELECTOR = [
  '[data-prompt-drawer-layer="true"]',
  '[data-prompt-floating-layer="true"]',
].join(",");

export const promptFloatingLayerProps = {
  "data-prompt-floating-layer": "true",
} as const;

/** Whether `target` is an element inside any of the given selectors. */
function within(target: EventTarget | null, ...selectors: string[]): boolean {
  if (!(target instanceof Element)) return false;
  return selectors.some((selector) => target.closest(selector) !== null);
}

export function usePromptMenuProps() {
  const promptRef = usePromptHandleContext();
  // Closing a menu hands focus back to the editor only when nothing else took it.
  const finalFocus = () => {
    const focused = document.activeElement;
    if (focused === document.body || isInsidePromptFloatingLayer(focused)) {
      promptRef?.current?.focusAtEnd();
    }
    return false;
  };
  return { ...promptFloatingLayerProps, finalFocus: promptRef ? finalFocus : undefined };
}

export function isInsidePromptFloatingLayer(target: EventTarget | null): boolean {
  return within(target, PROMPT_FLOATING_LAYER_SELECTOR);
}

// Banners, the approval row, and the tasks badge dock above the surface. A
// pointer or focus landing on one of them acts on that control and must not
// expand a resting or collapsed composer.
export function isInsideCollapsedPromptControls(target: EventTarget | null): boolean {
  return within(target, '[data-prompt-collapsed-controls="true"]');
}

export function isInsideRestingPromptControlScope(target: EventTarget | null): boolean {
  return within(
    target,
    '[data-prompt-resting-controls="true"]',
    '[data-prompt-resting-images="true"]',
    "[data-prompt-context-control]",
    PROMPT_FLOATING_LAYER_SELECTOR,
  );
}
