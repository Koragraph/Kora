/** Clear portaled menus when their measured, still-mounted triggers hide. */

import { useState } from "react";

export function usePromptMenuState(hidden = false) {
  const [isOpen, setIsOpen] = useState(false);
  // Base UI does not notify us when we close it by changing its open prop.
  // Reset the stored state too, so revealing the trigger cannot reopen it.
  if (isOpen && hidden) {
    setIsOpen(false);
  }
  return [!hidden && isOpen, setIsOpen] as const;
}
