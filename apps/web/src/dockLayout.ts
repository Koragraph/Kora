export const DOCK_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
// Applied only while a floating preview overlaps the compact sheet.
export const DOCK_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";

/**
 * A blob's side panel docks inline from 1100 px; below that it overlays the chat as a sheet. Live QA #3: at 900 px a docked
 * panel squeezed the chat to ~260 px and clipped the header and the model chip.
 */
export const BLOB_PANEL_SHEET_BREAKPOINT = 1100;
export const BLOB_PANEL_SHEET_MEDIA_QUERY = `(max-width: ${BLOB_PANEL_SHEET_BREAKPOINT - 1}px)`;
/** The chat column never gets narrower than this beside a docked blob panel. */
export const BLOB_CHAT_MIN_WIDTH = 420;
