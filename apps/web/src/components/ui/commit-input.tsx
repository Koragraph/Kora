"use client";

import { useCommitOnBlur } from "~/hooks/useBlurCommit";
import { type InputProps, Input } from "./input";

export type DraftInputProps = Omit<InputProps, "defaultValue" | "onChange" | "value"> & {
  readonly onCommit: (next: string) => void;
  readonly value: string;
};

/**
 * Text `<Input>` that buffers keystrokes locally and invokes `onCommit`
 * only when the user finishes editing (blur or Enter). Prevents each
 * keystroke from triggering a settings-wide re-render or a server RPC
 * round-trip, which otherwise makes fields backed by a server-hydrated
 * value feel laggy.
 */
export function DraftInput({ onCommit, value, ...rest }: DraftInputProps) {
  const bag = useCommitOnBlur(value, onCommit);
  return <Input {...rest} {...bag} />;
}
