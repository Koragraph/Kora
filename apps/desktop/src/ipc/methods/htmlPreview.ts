import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  HTML_PREVIEW_MAX_CHARS,
  htmlPreviewStore,
  htmlPreviewUrl,
} from "../../native/HtmlPreviewProtocol.ts";
import * as IpcChannels from "../channelNames.ts";
import * as ShellIpc from "../ShellIpc.ts";

/**
 * Registers agent-written HTML for the assistant lane's preview and returns the
 * `kora-preview://doc/<id>` URL it is served at (see HtmlPreviewProtocol.ts).
 * Only the app's own top-level frame can call it (ShellIpc sender gate).
 */
export const registerHtmlPreview = ShellIpc.defineIpcMethod({
  channel: IpcChannels.IPC_HTML_PREVIEW_REGISTER,
  payload: Schema.String.check(Schema.isMaxLength(HTML_PREVIEW_MAX_CHARS)),
  result: Schema.String,
  handler: (html) =>
    Effect.sync(() => htmlPreviewUrl(htmlPreviewStore().put(html))).pipe(
      Effect.withSpan("shell.ipc.htmlPreview.register"),
    ),
});
