import { atom } from "nanostores";

/**
 * Whether the Spotify window is out of sight: minimized, on another virtual
 * desktop, or fully covered by another window.
 *
 * This is deliberately not "does the window have focus". Working in another app
 * next to a visible Spotify must keep the lyrics moving; only a window nobody
 * can see should stop animating. The Page Visibility API matches that: Chromium
 * reports a fully occluded window as hidden, while losing focus alone leaves it
 * visible.
 *
 * Where the platform doesn't report occlusion (some Linux/Wayland setups, or a
 * client started with backgrounding disabled) the fallback is the frame clock:
 * a covered window stops being rendered, so a requestAnimationFrame that hasn't
 * fired for a while means nothing of it is on screen. Timers still run, so the
 * watchdog can notice the stall.
 */

export const $windowHidden = atom(
  typeof document !== "undefined" && document.visibilityState === "hidden"
);

const HIDDEN_CLASS = "SpicyLyrics_WindowHidden";

// Long enough that a slow machine or one long task can't trip it, short enough
// that a covered window stops animating soon after it is covered.
const STALL_MS = 2000;
const CHECK_MS = 1000;

let lastFrameAt = typeof performance !== "undefined" ? performance.now() : 0;

function setHidden(hidden: boolean): void {
  if ($windowHidden.get() === hidden) return;
  $windowHidden.set(hidden);
  document.documentElement.classList.toggle(HIDDEN_CLASS, hidden);
}

/** True while the window is hidden or fully covered. */
export function IsWindowHidden(): boolean {
  return $windowHidden.get();
}

/**
 * Called from the shared animation loop on every frame it receives. A frame is
 * proof the window is being rendered, so it also clears a stall-detected hide.
 */
export function MarkAnimationFrame(timestamp: number): void {
  lastFrameAt = timestamp;
  if ($windowHidden.get() && !document.hidden) setHidden(false);
}

function onVisibilityChange(): void {
  lastFrameAt = performance.now();
  setHidden(document.visibilityState === "hidden");
}

function onFocus(): void {
  // Regaining focus doesn't prove the window is visible (another window can
  // still cover it), but the next frame does; reset the stall baseline so the
  // watchdog doesn't fire in the gap.
  lastFrameAt = performance.now();
  if (!document.hidden) setHidden(false);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", onFocus);
  // A page restored from the back/forward cache may skip visibilitychange.
  window.addEventListener("pageshow", onVisibilityChange);

  setInterval(() => {
    if (document.hidden || $windowHidden.get()) return;
    // A focused window is on top by definition, so a stall there is a long task,
    // not occlusion.
    if (document.hasFocus()) return;
    if (performance.now() - lastFrameAt < STALL_MS) return;
    setHidden(true);
  }, CHECK_MS);
}
