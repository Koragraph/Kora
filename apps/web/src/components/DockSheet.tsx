import { SheetPopup, Sheet } from "./ui/sheet";
import { DOCK_SHEET_CLASS_NAME } from "../dockLayout";
import { type ReactNode } from "react";

export function DockSheet(props: {
  animationDurationMs: number;
  onClose: () => void;
  children: ReactNode;
  open: boolean;
}) {
  const closeWhenDismissed = (open: boolean) => {
    if (open === false) {
      props.onClose();
    }
  };

  return (
    <Sheet onOpenChange={closeWhenDismissed} open={props.open}>
      <SheetPopup
        // Focus moves into the sheet only for keyboard opens; a click must not leave a focus ring on the first tab.
        initialFocus={(openType) => openType === "keyboard"}
        transitionDurationMs={props.animationDurationMs}
        className={DOCK_SHEET_CLASS_NAME}
        showCloseButton={false}
        side="right"
        keepMounted
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
