import { create } from "zustand";

export interface BrowserSurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserSurfaceContentPresentation {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface BrowserSurfacePresentation {
  rect: BrowserSurfaceRect | null;
  visible: boolean;
  zIndex: number;
  content: BrowserSurfaceContentPresentation | null;
  /** Content captured once, so a fitted copy keeps the source's dimensions. */
  fittedSourceContent: BrowserSurfaceContentPresentation | null;
  fitSourceContent: boolean;
  cornerRadius: number;
  updatedAt: number;
  owner: symbol | null;
}

export interface BrowserSurfaceLease {
  present(
    rect: BrowserSurfaceRect,
    shown: boolean,
    cornerRadius?: number,
    zIndex?: number,
  ): boolean;
  release(): void;
}

interface BrowserSurfaceState {
  activityByTabId: Record<string, number>;
  byTabId: Record<string, BrowserSurfacePresentation>;
  acquireActivity: (tabKey: string) => () => void;
  claim: (tabKey: string, holder: symbol, fitSourceContent: boolean) => void;
  present: (
    tabKey: string,
    holder: symbol,
    rect: BrowserSurfaceRect,
    shown: boolean,
    cornerRadius: number,
    zIndex: number,
  ) => void;
  presentContent: (tabKey: string, contentBody: BrowserSurfaceContentPresentation) => void;
  release: (tabKey: string, holder: symbol) => void;
}

const DEFAULT_Z_INDEX = 30;

const sameRect = (stored: BrowserSurfaceRect | null, incoming: BrowserSurfaceRect) =>
  stored !== null &&
  stored.x === incoming.x &&
  stored.y === incoming.y &&
  stored.width === incoming.width &&
  stored.height === incoming.height;

const sameContent = (
  stored: BrowserSurfaceContentPresentation | null,
  incoming: BrowserSurfaceContentPresentation,
) =>
  stored !== null &&
  stored.x === incoming.x &&
  stored.y === incoming.y &&
  stored.width === incoming.width &&
  stored.height === incoming.height &&
  stored.scale === incoming.scale &&
  stored.scrollLeft === incoming.scrollLeft &&
  stored.scrollTop === incoming.scrollTop;

const placeholder = (): BrowserSurfacePresentation => ({
  owner: null,
  updatedAt: 0,
  cornerRadius: 0,
  fitSourceContent: false,
  fittedSourceContent: null,
  content: null,
  zIndex: DEFAULT_Z_INDEX,
  visible: false,
  rect: null,
});

export const usePreviewDockStore = create<BrowserSurfaceState>((bag, get) => ({
  release: (tabKey, holder) =>
    bag((current) => {
      const live = current.byTabId[tabKey];
      if (!live || live.owner !== holder) return current;
      // Rect and content stay so the overlay can be hidden gracefully.
      return {
        byTabId: {
          ...current.byTabId,
          [tabKey]: {
            ...live,
            owner: null,
            fitSourceContent: false,
            visible: false,
            fittedSourceContent: null,
            updatedAt: Date.now(),
          },
        },
      };
    }),

  presentContent: (tabKey, contentBody) =>
    bag((current) => {
      const live = current.byTabId[tabKey] ?? placeholder();
      if (sameContent(live.content, contentBody)) return current;
      return {
        byTabId: {
          ...current.byTabId,
          [tabKey]: {
            ...live,
            content: contentBody,
            fittedSourceContent:
              live.fitSourceContent && live.fittedSourceContent === null
                ? contentBody
                : live.fittedSourceContent,
            updatedAt: Date.now(),
          },
        },
      };
    }),

  present: (tabKey, holder, rect, shown, cornerRadius, zIndex) =>
    bag((current) => {
      const live = current.byTabId[tabKey];
      if (!live || live.owner !== holder) return current;
      if (
        sameRect(live.rect, rect) &&
        live.visible === shown &&
        live.cornerRadius === cornerRadius &&
        live.zIndex === zIndex
      ) {
        return current;
      }
      return {
        byTabId: {
          ...current.byTabId,
          [tabKey]: {
            ...live,
            rect: rect,
            visible: shown,
            cornerRadius,
            zIndex,
            updatedAt: Date.now(),
          },
        },
      };
    }),

  claim: (tabKey, holder, fitSourceContent) =>
    bag((current) => {
      const prior = current.byTabId[tabKey];
      if (prior?.owner === holder) return current;
      return {
        byTabId: {
          ...current.byTabId,
          [tabKey]: {
            rect: prior?.rect ?? null,
            visible: false,
            zIndex: prior?.zIndex ?? DEFAULT_Z_INDEX,
            content: prior?.content ?? null,
            fittedSourceContent: fitSourceContent ? (prior?.content ?? null) : null,
            fitSourceContent,
            cornerRadius: prior?.cornerRadius ?? 0,
            updatedAt: Date.now(),
            owner: holder,
          },
        },
      };
    }),

  acquireActivity: (tabKey) => {
    bag((current) => ({
      activityByTabId: {
        ...current.activityByTabId,
        [tabKey]: (current.activityByTabId[tabKey] ?? 0) + 1,
      },
    }));
    return runOnce(() => {
      bag((current) => {
        const upcoming = (current.activityByTabId[tabKey] ?? 0) - 1;
        const { [tabKey]: _old, ...others } = current.activityByTabId;
        return { activityByTabId: upcoming > 0 ? { ...others, [tabKey]: upcoming } : others };
      });
    });
  },
  byTabId: {},
  activityByTabId: {},
}));

const runOnce = (action: () => void): (() => void) => {
  let spent = false;
  return () => {
    if (spent) return;
    spent = true;
    action();
  };
};

export const resolveBrowserSurfacePanelRect = (
  byTabId: Record<string, BrowserSurfacePresentation>,
  tabKey: string,
): BrowserSurfaceRect | null => byTabId[tabKey]?.rect ?? null;

export const acquireBrowserSurfaceActivity = (tabKey: string): (() => void) =>
  usePreviewDockStore.getState().acquireActivity(tabKey);

export function acquireBrowserSurface(
  tabKey: string,
  fitSourceContent = false,
): BrowserSurfaceLease {
  const holder = Symbol(`browser-surface:${tabKey}`);
  let released = false;
  usePreviewDockStore.getState().claim(tabKey, holder, fitSourceContent);

  return {
    present: (rect, shown, cornerRadius = 0, zIndex = DEFAULT_Z_INDEX) => {
      const store = usePreviewDockStore.getState();
      // A newer lease took the tab: the caller must acquire again.
      if (released || store.byTabId[tabKey]?.owner !== holder) return false;
      store.present(tabKey, holder, rect, shown, cornerRadius, zIndex);
      return true;
    },
    release: runOnce(() => {
      released = true;
      usePreviewDockStore.getState().release(tabKey, holder);
    }),
  };
}
