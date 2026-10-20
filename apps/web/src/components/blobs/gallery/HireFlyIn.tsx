import { usePrefersReducedMotion, defaultOutfitFor, BlobAvatar } from "~/components/blobs/avatar";
import { flightPoint } from "~/components/assistant/blobFlightPath";
import { flightController, arcKeyframes, type Flight } from "./flyToRoster";
import { announceBlobCreated } from "../shell/blobReaction";
import { createPortal } from "react-dom";
// The portal layer that draws hire flights (flyToRoster.ts). Mount ONE <HireFlyInLayer /> near the app root of the Blobs
// surface (see PHASE2-WEB-WIRING.md). Each flight is a fixed-position BlobAvatar animated with the Web Animations API
// along the same arc as the result-carry flight; with reduced motion it simply fades in at the roster row.
import { useSyncExternalStore, useLayoutEffect, useEffect, useRef } from "react";
import "./gallery.css";

const FLIGHT_MS = 760;
const GONE_MS = 420;

function useFlights(): ReadonlyArray<Flight> {
  return useSyncExternalStore(
    flightController.subscribe,
    flightController.getFlights,
    () => [] as ReadonlyArray<Flight>,
  );
}

export function HireFlyInLayer(): React.ReactPortal | null {
  const flights = useFlights();
  const reduced = usePrefersReducedMotion();

  useEffect(() => flightController.registerLayer(), []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="hire-fly-layer" aria-hidden data-hire-fly-layer>
      {flights.map((flight) => (
        <FlightAvatar key={flight.id} flight={flight} reduced={reduced} />
      ))}
    </div>,
    document.body,
  );
}

function FlightAvatar({ flight, reduced }: { readonly flight: Flight; readonly reduced: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { from, to, phase } = flight;
  const size = Math.max(16, Math.round(Math.min(from.width, from.height)));

  // Park at the card while the roster row is being found.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || phase !== "waiting") return;
    el.style.transform = `translate(${from.left}px, ${from.top}px)`;
  }, [from, phase]);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    if (phase === "gone") {
      const anim = el.animate?.([{ opacity: 1 }, { opacity: 0 }], {
        duration: GONE_MS,
        fill: "forwards",
        delay: 0,
      });
      const timer = setTimeout(() => flightController.finish(flight.id), GONE_MS + 60);
      if (anim) anim.onfinish = () => flightController.finish(flight.id);
      return () => clearTimeout(timer);
    }
    if (phase !== "flying" || !to) return;

    const done = () => flightController.finish(flight.id);
    if (reduced || typeof el.animate !== "function") {
      el.style.transform = `translate(${to.left}px, ${to.top}px)`;
      el.style.width = `${to.width}px`;
      el.style.height = `${to.height}px`;
      const timer = setTimeout(done, reduced ? 320 : 0);
      return () => clearTimeout(timer);
    }
    // The element is `from.width` wide, positioned by translate of its top-left; scale about its centre.
    const frames = arcKeyframes(from, to, flightPoint).map((k) => ({
      transform: `translate(${k.x - from.width / 2}px, ${k.y - from.height / 2}px) scale(${k.scale})`,
      offset: k.t,
    }));
    const anim = el.animate(frames, {
      duration: FLIGHT_MS,
      delay: flight.delayMs,
      easing: "linear",
      fill: "both",
    });
    anim.onfinish = done;
    const guard = setTimeout(done, FLIGHT_MS + flight.delayMs + 400);
    return () => {
      clearTimeout(guard);
      anim.onfinish = null;
    };
  }, [phase, to, from, reduced, flight.id, flight.delayMs]);

  return (
    <div
      ref={ref}
      className="hire-fly-avatar"
      data-hire-fly={flight.blobId}
      data-phase={phase}
      style={{
        width: from.width,
        height: from.height,
        transform: `translate(${from.left}px, ${from.top}px)`,
        opacity: phase === "flying" && reduced ? 0 : undefined,
      }}
    >
      <BlobAvatar
        outfit={flight.outfit ?? defaultOutfitFor(flight.blobId)}
        state={phase === "flying" ? "working" : "idle"}
        size={size}
        eyesFollowCursor={false}
        seed={flight.blobId}
      />
    </div>
  );
}

/** What a hire surface passes so the roster row waves when the blob touches down. */
export const landAndWave = (blobId: string): void => announceBlobCreated(blobId);
