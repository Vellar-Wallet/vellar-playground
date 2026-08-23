"use client";

import { useEffect, useState } from "react";

/** Tracks which of a fixed set of section ids is currently most visible in
 *  the viewport, using a plain IntersectionObserver — no scroll-position
 *  math, no external library. Built for the "/" guided-demo page's station
 *  jump-nav (see StationNav in app/(dashboard)/page.tsx): three stations
 *  stack on one page, and this is what highlights the active one as the
 *  visitor scrolls, mirroring the "which nav item is active" pattern the
 *  sidebar already does for whole-page routes (see dashboard-shell.tsx's
 *  isActive), just scoped to in-page sections instead.
 *
 *  No sibling hook exists in this repo to import from — vela-wallet's own
 *  landing page (a different app entirely) is known to use a
 *  use-scroll-spy.ts hook for the same purpose, which is precedent that
 *  this pattern belongs in this product family, not evidence to copy code
 *  from (this repo has no access to that other app's source).
 *
 *  rootMargin biases the "active" boundary toward the upper third of the
 *  viewport (as if there were a sticky header the size of one nav bar) so a
 *  section is marked active once its heading has scrolled into a
 *  comfortable reading position, not merely the instant its top pixel
 *  appears at the very bottom of the screen. */
export function useScrollSpy(sectionIds: string[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const elements = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const visible = new Map<string, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visible.set(entry.target.id, entry.intersectionRatio);
          } else {
            visible.delete(entry.target.id);
          }
        }
        if (visible.size === 0) return;
        // Prefer whichever visible section appears first in sectionIds
        // order among ties, rather than whichever the Map happens to
        // iterate first — keeps the highlighted item stable and matching
        // reading order.
        const topMost = sectionIds.find((id) => visible.has(id));
        if (topMost) setActiveId(topMost);
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: [0, 0.1, 0.5, 1] },
    );

    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [sectionIds]);

  return activeId;
}
