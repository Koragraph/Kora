// Off-main-thread preview parsing (spreadsheets can be tens of MB). One handler per worker; see previewHandler.ts.
import { createPreviewHandler, type PreviewRequest } from "./previewHandler";

const handle = createPreviewHandler();

self.onmessage = (event: MessageEvent<{ id: number; request: PreviewRequest }>) => {
  const { id, request } = event.data;
  void handle(request).then((result) => {
    (self as unknown as { postMessage: (message: unknown) => void }).postMessage({ id, result });
  });
};
