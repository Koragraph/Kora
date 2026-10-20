import { type ChangeEvent, type KeyboardEvent, useState } from "react";

/**
 * Buffer text input locally so keystrokes don't cause a settings-wide
 * re-render (and optionally a server RPC round-trip) on every character.
 * `onCommit` fires on blur and on Enter.
 *
 * The draft resynchronizes from the incoming `value` only when the input
 * is not focused, so an external push (e.g. an optimistic settings
 * update from the user's own commit, or a reset to defaults) doesn't
 * clobber an in-progress edit.
 *
 * Returns a bag of props that should be spread onto an `<Input>`:
 *
 *   const bag = useCommitOnBlur(instance.displayName ?? "", (next) => {...});
 *   <Input {...bag} placeholder="e.g. Work" />
 */
export function useCommitOnBlur(val: string, onCommit: (upcoming: string) => void) {
  const [draft, setDraft] = useState<string | null>(null);

  return {
    value: draft ?? val,
    onChange: (evt: ChangeEvent<HTMLInputElement>) => {
      setDraft(evt.target.value);
    },
    onFocus: () => {
      setDraft(val);
    },
    onBlur: () => {
      const upcoming = draft ?? val;
      setDraft(null);
      if (upcoming !== val) {
        onCommit(upcoming);
      }
    },
    onKeyDown: (evt: KeyboardEvent<HTMLInputElement>) => {
      if (evt.nativeEvent.isComposing || evt.keyCode === 229) return;
      if (evt.key === "Enter") {
        evt.preventDefault();
        (evt.target as HTMLInputElement).blur();
      }
    },
  };
}
