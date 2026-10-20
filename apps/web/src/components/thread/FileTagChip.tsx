import { FileEntryIcon } from "./FileEntryIcon";
import { mark, pill } from "../tagStyles";
import { inferEntryKindFromPath } from "../../appearance/pierre-icons";

export const FILE_TAG_CHIP_CLASS_NAME = `${pill.base} ${pill.tint}`;
export const CHAT_FILE_TAG_CHIP_CLASS_NAME = `${mark.base} ${mark.tint}`;

export function FileTagBody(props: {
  theme: "light" | "dark";
  selectable?: boolean;
  label: string;
  path: string;
}) {
  return (
    <>
      {/* A highlighter mark is just marked text — the composer's attached-file pill still
          gets the small language icon since it's picking between distinct file objects,
          but a sent message's inline reference doesn't need one. */}
      {props.selectable ? null : (
        <FileEntryIcon
          className={pill.icon}
          kind={inferEntryKindFromPath(props.path)}
          pathValue={props.path}
          theme={props.theme}
        />
      )}
      <span className={props.selectable ? mark.label : pill.label}>{props.label}</span>
    </>
  );
}
