import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WizardSteps } from "./stepper";

const SWARM_STEPS = ["How it works", "OpenCode", "Workers", "Ready"];

describe("WizardSteps", () => {
  it("sizes step tabs to their labels instead of forcing equal columns", () => {
    const html = renderToStaticMarkup(<WizardSteps steps={SWARM_STEPS} currentStep={0} />);
    expect(html).not.toContain("auto-cols-fr");
    expect(html).toMatch(/<ol class="flex /);
    expect(html.match(/<li class="min-w-0 flex-auto">/g)).toHaveLength(SWARM_STEPS.length);
  });

  it("renders every step label in full, never truncated", () => {
    const html = renderToStaticMarkup(
      <WizardSteps
        steps={SWARM_STEPS}
        currentStep={2}
        showSummaries
        summaries={["A very long summary that may well need an ellipsis", "Installed", null, null]}
      />,
    );
    for (const step of SWARM_STEPS) {
      expect(html).toContain(
        `<span data-wizard-step-label="true" class="shrink-0 whitespace-nowrap">${step}</span>`,
      );
    }
    // Only the summary may truncate.
    expect(html).toContain('<span class="min-w-0 truncate">: A very long summary');
  });
});
