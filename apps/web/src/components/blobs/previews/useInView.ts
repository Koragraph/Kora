// "Has this element been on screen yet?" - latches true. Cards use it to fetch and parse a file only when the
// message is actually scrolled into view (the transcript is virtualized and can hold dozens of files).
import { useEffect, useRef, useState } from "react";

export function useInView<T extends Element>(): { ref: React.RefObject<T | null>; seen: boolean } {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  return { ref, seen };
}
