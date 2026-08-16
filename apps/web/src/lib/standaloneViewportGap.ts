const GAP_PROPERTY = "--standalone-viewport-gap";
const SHIFT_CLASS_NAME = "standalone-viewport-shift";

/* Differences larger than a status bar mean the layout viewport shrank for
   another reason (software keyboard, Stage Manager window); keep the last
   known alignment rather than shifting by a bogus amount. */
const MAX_PLAUSIBLE_GAP = 80;

interface NavigatorWithStandalone extends Navigator {
  readonly standalone?: boolean;
}

/* screen.width/height may stay portrait-fixed while the device rotates, so
   pick the screen dimension that matches the viewport's orientation. */
function measureViewportGap(): number | null {
  const viewportPortrait = window.innerHeight >= window.innerWidth;
  const screenPortrait = window.screen.width <= window.screen.height;
  const screenHeight =
    viewportPortrait === screenPortrait ? window.screen.height : window.screen.width;
  const gap = screenHeight - window.innerHeight;
  return gap >= 0 && gap <= MAX_PLAUSIBLE_GAP ? gap : null;
}

/**
 * iPadOS home-screen web apps can lay the page out against a viewport that is
 * one status bar shorter than the web view and anchored to the top of the
 * screen: content (including position:fixed chrome) slides under the status
 * bar, and the bottom of the web view shows a dead band of page background.
 * `env(safe-area-inset-*)` cannot express the misalignment — WebKit reports
 * the inset it failed to apply — so measure the real gap and let the CSS
 * shift the whole body down by it (see the standalone-viewport-shift rules
 * in index.css).
 */
export function syncStandaloneViewportShift(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  if ((navigator as NavigatorWithStandalone).standalone !== true) {
    return () => {};
  }

  const root = document.documentElement;
  const update = () => {
    const gap = measureViewportGap();
    if (gap === null) {
      return;
    }
    root.classList.toggle(SHIFT_CLASS_NAME, gap > 0);
    if (gap > 0) {
      root.style.setProperty(GAP_PROPERTY, `${gap}px`);
    } else {
      root.style.removeProperty(GAP_PROPERTY);
    }
  };

  update();
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  return () => {
    window.removeEventListener("resize", update);
    window.removeEventListener("orientationchange", update);
  };
}
