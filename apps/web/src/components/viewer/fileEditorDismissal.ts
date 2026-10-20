interface FileEditorDismissalOptions {
  root: HTMLElement;
  onDismiss: () => void;
  isBlocked: () => boolean;
  editor: {
    setSelections: (selections: []) => void;
  };
}

function dismissFileEditorInteraction({
  root,
  editor,
  onDismiss,
}: Pick<FileEditorDismissalOptions, "onDismiss" | "editor" | "root">): void {
  try {
    editor.setSelections([]);
  } catch {
    // A click outside while the file's editor is still mounting: the library throws "Text document is not
    // initialized" and there is nothing to deselect yet. Letting it escape is an uncaught page error.
  }
  onDismiss();

  const host = root.querySelector<HTMLElement>("diffs-container");
  const focused = host?.shadowRoot?.activeElement;
  if (focused instanceof HTMLElement) {
    focused.blur();
  }
}

export function installFileEditorDismissal(incoming: FileEditorDismissalOptions): () => void {
  const { root, editor, isBlocked, onDismiss } = incoming;
  const handlePointerDown = (event: PointerEvent) => {
    if (isBlocked() || event.composedPath().includes(root)) return;
    dismissFileEditorInteraction({ onDismiss, editor, root });
  };

  document.addEventListener("pointerdown", handlePointerDown, true);
  return () => {
    document.removeEventListener("pointerdown", handlePointerDown, true);
  };
}
