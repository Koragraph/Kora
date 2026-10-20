// The blob side panel's open state + active tab, remembered across blobs and sessions (client-only convenience).
import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";

export const BLOB_PANEL_TABS = ["profile", "memory", "files", "computer", "runs"] as const;
export type BlobPanelTab = (typeof BLOB_PANEL_TABS)[number];

const PanelStateSchema = Schema.Struct({
  open: Schema.Boolean,
  tab: Schema.Literals(BLOB_PANEL_TABS),
});
type PanelState = typeof PanelStateSchema.Type;

const KEY = "kora.blobs.panel.v1";
const DEFAULT_STATE: PanelState = { open: false, tab: "profile" };

export function useBlobPanel() {
  const [state, setState] = useLocalStorage<PanelState, unknown>(
    KEY,
    DEFAULT_STATE,
    PanelStateSchema,
  );
  return {
    open: state.open,
    tab: state.tab,
    setOpen: (open: boolean) => setState({ ...state, open }),
    toggle: () => setState({ ...state, open: !state.open }),
    setTab: (tab: BlobPanelTab) => setState({ ...state, tab }),
    show: (tab: BlobPanelTab) => setState({ open: true, tab }),
  };
}
