import { resolvePathLinkTarget } from "~/thread/terminal-links";
import ReplyMarkdown from "~/components/ReplyMarkdown";
import type { HostThreadRef } from "@kora/contracts";

type TaskListChangeHandler = (input: {
  readonly markerOffset: number;
  readonly checked: boolean;
}) => void;

export function FileMarkdownPreview(props: {
  readonly text: string;
  readonly relativePath: string;
  readonly threadRef: HostThreadRef;
  readonly cwd: string;
  readonly onTaskListChange?: TaskListChangeHandler | undefined;
}) {
  const { relativePath, cwd } = props;
  const slashAt = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
  const imageBaseDir =
    slashAt < 0 ? cwd : resolvePathLinkTarget(relativePath.slice(0, slashAt), cwd);

  return (
    <ReplyMarkdown
      onTaskListChange={props.onTaskListChange}
      className="mx-auto max-w-4xl px-6 py-5"
      threadRef={props.threadRef}
      imageBaseDir={imageBaseDir}
      text={props.text}
      cwd={props.cwd}
    />
  );
}
