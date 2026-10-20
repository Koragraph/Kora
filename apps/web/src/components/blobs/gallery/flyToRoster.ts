// The hire fly-in, minus React: `flyToRoster(fromRect, blobId)` sends a copy of the blob from where it was hired
// (a gallery card, a proposal card) to its roster row. The controller is a tiny external store (the layer in
// HireFlyIn.tsx renders it) so it can be driven and tested without a DOM.
//
//   - no layer mounted, reduced motion handled by the layer, or the roster row never appears => it resolves
//     `{ landed: false }` and nobody is stuck: the hire itself already happened, this is only the flourish.
//   - the arc reuses `flightPoint` from assistant/blobFlightPath.ts (the result-carry flight), lifted a little more.
import type { BlobOutfit } from "~/components/blobs/avatar";

export interface RectLike {
  readonly height: number;
  readonly width: number;
  readonly left: number;
  readonly top: number;
}

export interface FlightOptions {
  /** The blob's look; omitted => the layer draws the default for `blobId`. */
  readonly outfit?: BlobOutfit;
  readonly name?: string;
  /** Delay before take-off, for staggering several blobs (ms). */
  readonly delayMs?: number;
  /** How long to wait for the roster row to exist (the snapshot lands a beat after the hire). Default 1800. */
  readonly targetWaitMs?: number;
  /** Fires on touch-down (the roster row waves via `announceBlobCreated`). */
  readonly onLand?: (blobId: string) => void;
}

export interface Flight {
  readonly id: number;
  readonly blobId: string;
  readonly name: string | null;
  readonly outfit: BlobOutfit | null;
  readonly from: RectLike;
  /** null while waiting for the roster row; "gone" when it never appeared (the blob just fades). */
  readonly to: RectLike | null;
  readonly phase: "waiting" | "flying" | "gone";
  readonly delayMs: number;
}

export interface FlightResult {
  readonly landed: boolean;
}

export interface FlightControllerDeps {
  /** The roster row's avatar box, or null when it is not on screen. */
  readonly findTarget: (blobId: string) => RectLike | null;
  readonly pollMs?: number;
}

export interface FlightController {
  readonly flyToRoster: (
    from: RectLike,
    blobId: string,
    options?: FlightOptions,
  ) => Promise<FlightResult>;
  /** The layer calls this when a flight's animation ends. */
  readonly finish: (flightId: number) => void;
  readonly registerLayer: () => () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getFlights: () => ReadonlyArray<Flight>;
}

export function createFlightController(deps: FlightControllerDeps): FlightController {
  let flights: ReadonlyArray<Flight> = [];
  let layers = 0;
  let nextId = 1;
  const listeners = new Set<() => void>();
  const settlers = new Map<
    number,
    { resolve: (r: FlightResult) => void; landed: boolean; onLand?: () => void }
  >();
  const emit = () => {
    for (const l of listeners) l();
  };
  const patch = (id: number, change: Partial<Flight>) => {
    flights = flights.map((f) => (f.id === id ? { ...f, ...change } : f));
    emit();
  };
  const remove = (id: number) => {
    flights = flights.filter((f) => f.id !== id);
    emit();
  };

  const finish = (flightId: number) => {
    const settler = settlers.get(flightId);
    if (!settler) return;
    settlers.delete(flightId);
    remove(flightId);
    if (settler.landed) settler.onLand?.();
    settler.resolve({ landed: settler.landed });
  };

  const flyToRoster: FlightController["flyToRoster"] = (from, blobId, options = {}) => {
    if (layers === 0) return Promise.resolve({ landed: false });
    const id = nextId++;
    const pollMs = deps.pollMs ?? 60;
    const waitMs = options.targetWaitMs ?? 1800;
    return new Promise<FlightResult>((resolve) => {
      settlers.set(id, {
        resolve,
        landed: false,
        ...(options.onLand ? { onLand: () => options.onLand?.(blobId) } : {}),
      });
      flights = [
        ...flights,
        {
          id,
          blobId,
          name: options.name ?? null,
          outfit: options.outfit ?? null,
          from,
          to: null,
          phase: "waiting",
          delayMs: options.delayMs ?? 0,
        },
      ];
      emit();
      const startedAt = Date.now();
      const look = () => {
        if (!settlers.has(id)) return;
        const target = deps.findTarget(blobId);
        if (target) {
          const settler = settlers.get(id);
          if (settler) settler.landed = true;
          patch(id, { to: target, phase: "flying" });
          return;
        }
        if (Date.now() - startedAt >= waitMs) {
          patch(id, { phase: "gone" });
          return;
        }
        setTimeout(look, pollMs);
      };
      look();
    });
  };

  return {
    getFlights: () => flights,
    registerLayer: () => {
      layers += 1;
      let alreadyReleased = false;
      return () => {
        if (alreadyReleased) return;
        alreadyReleased = true;
        layers -= 1;
        if (layers === 0) {
          // Nobody can draw the flights any more: settle them so no caller waits forever.
          for (const flight of flights) finish(flight.id);
        }
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flyToRoster,
    finish,
  };
}

/** The roster row's avatar box (`BlobRosterRow` marks the row with `data-blob-id`; the avatar is its `data-state` span). */
function findRosterTarget(blobId: string): RectLike | null {
  if (typeof document === "undefined") return null;
  const id =
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(blobId) : blobId.replace(/"/g, '\\"');
  const row = document.querySelector<HTMLElement>(`[data-blob-id="${id}"]`);
  if (!row) return null;
  const avatar = row.querySelector<HTMLElement>("[data-state]") ?? row;
  const rect = avatar.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  // A row scrolled out of the sidebar's viewport still has a rect: aim at where it is, the sidebar clips nothing here.
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export const flightController = createFlightController({ findTarget: findRosterTarget });

/** Send a copy of a just-hired blob from `fromRect` to its roster slot. Safe to call anywhere; never rejects. */
export function flyToRoster(
  fromRect: RectLike,
  blobId: string,
  options?: FlightOptions,
): Promise<FlightResult> {
  return flightController.flyToRoster(fromRect, blobId, options);
}

export function rectOf(element: Element | null | undefined): RectLike | null {
  if (!element) return null;
  const r = element.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** Quadratic arc between two box centres, eased; the geometry the layer samples into WAAPI keyframes. */
export function arcKeyframes(
  from: RectLike,
  to: RectLike,
  flightPointFn: (
    a: { x: number; y: number },
    b: { x: number; y: number },
    t: number,
  ) => { x: number; y: number },
  steps = 18,
): ReadonlyArray<{ x: number; y: number; scale: number; t: number }> {
  const a = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
  const b = { x: to.left + to.width / 2, y: to.top + to.height / 2 };
  const startScale = 1;
  const endScale = to.width / Math.max(1, from.width);
  const out: Array<{ x: number; y: number; scale: number; t: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const raw = i / steps;
    const eased = raw * raw * (3 - 2 * raw); // smoothstep: leaves the card gently, settles into the row
    const p = flightPointFn(a, b, eased);
    out.push({ x: p.x, y: p.y, scale: startScale + (endScale - startScale) * eased, t: raw });
  }
  return out;
}
