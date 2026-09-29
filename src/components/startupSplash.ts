/**
 * Drives the startup splash's progress bar (markup in layout.tsx, styles in
 * globals.css under "Startup splash").
 *
 * Reported: "the loading of the default screen on startup ... the bar
 * doesn't move, it's just static". The old bar was an indeterminate sliver
 * on a CSS loop. Under `prefers-reduced-motion` (Windows "Animation effects"
 * off is enough) the loop was switched off and the sliver sat frozen for the
 * whole wait; with motion allowed it said nothing about how far along the
 * start was, and then vanished mid-sweep.
 *
 * Now the bar is progress, in two layers:
 *
 * 1. Before any JS: a CSS animation on the fill creeps it from a small nub
 *    towards ~half, fast at first and ever slower, paced to the 12s
 *    failsafe. It is a transform animation, so the compositor runs it even
 *    while the main thread is busy parsing and hydrating the bundle — the
 *    stretch where a script-driven bar would freeze.
 *
 * 2. Once the page mounts, this module takes the fill over at whatever point
 *    the CSS creep had reached (read from the computed style, so there is no
 *    jump back) and steps it through the real milestones with an eased fill,
 *    each followed by a slow creep towards — never onto — the next stage, so
 *    a slow chat-list fetch still reads as working. Web Animations on
 *    `transform` keep this on the compositor too.
 *
 * Finishing fills the bar to 100%, and only then does the splash fade out
 * (.is-done), so it ends rather than vanishes.
 *
 * Reduced motion drops the decorative loops (the bouncing mark, the sheen)
 * but keeps the fill: it is the information on this screen, it moves slowly
 * across a 3px strip, and switching it off is exactly what made the old bar
 * look broken.
 */

/** Stage fill targets, as a fraction of the bar. */
const APP_RUNNING = 0.42;
const ONE_MILESTONE = 0.64;
/** How far a stage may creep while waiting; always short of the next stage. */
const CAP_AFTER_APP = 0.6;
const CAP_AFTER_ONE = 0.86;

/** Eased fill to a stage, then the slow creep that follows it. */
const STEP_MS = 500;
const CREEP_MS = 10_000;
/** Final fill, then the splash's own 0.3s fade (globals.css). */
const FINISH_MS = 300;
const FADE_MS = 300;

const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const CREEP_EASE = "cubic-bezier(0.2, 0.6, 0.35, 1)";

let running: Animation | null = null;
let finished = false;

function splashParts(): { splash: HTMLElement; fill: HTMLElement | null } | null {
  const splash = document.getElementById("app-splash");
  if (!splash) return null;
  return { splash, fill: splash.querySelector<HTMLElement>(".app-splash-fill") };
}

const at = (p: number) => `translateX(${((p - 1) * 100).toFixed(2)}%)`;

/**
 * Where the fill is right now, wherever that came from (the CSS creep or a
 * previous stage's animation), and stop whatever was moving it.
 */
function takeOver(fill: HTMLElement): number {
  let p = 0;
  try {
    const m = new DOMMatrixReadOnly(getComputedStyle(fill).transform);
    const w = fill.offsetWidth;
    if (w > 0) p = 1 + m.m41 / w;
  } catch {
    /* "none" or an unparsable value: treat as empty */
  }
  running?.cancel();
  running = null;
  fill.style.animation = "none";
  return Math.min(1, Math.max(0, p));
}

function animateFill(
  fill: HTMLElement,
  from: number,
  to: number,
  cap: number | null
): Animation | null {
  if (typeof fill.animate !== "function") {
    fill.style.transform = at(to);
    return null;
  }
  if (cap === null) {
    return fill.animate([{ transform: at(from) }, { transform: at(to) }], {
      duration: FINISH_MS,
      easing: EASE_OUT,
      fill: "forwards",
    });
  }
  const total = STEP_MS + CREEP_MS;
  return fill.animate(
    [
      { transform: at(from), easing: EASE_OUT },
      { transform: at(to), offset: STEP_MS / total, easing: CREEP_EASE },
      { transform: at(cap) },
    ],
    { duration: total, fill: "forwards" }
  );
}

/**
 * Report the milestones reached so far. Safe to call repeatedly (React
 * strict mode runs effects twice); each call continues from where the bar
 * currently is and never moves it backwards.
 */
export function advanceSplash(settingsRead: boolean, chatsListed: boolean): void {
  if (finished || typeof document === "undefined") return;
  const parts = splashParts();
  if (!parts) return;
  const { splash, fill } = parts;

  const done = Number(settingsRead) + Number(chatsListed);
  splash.dataset.stage = chatsListed ? "chats" : settingsRead ? "settings" : "app";
  if (!fill) return;

  const target = done === 0 ? APP_RUNNING : ONE_MILESTONE;
  const cap = done === 0 ? CAP_AFTER_APP : CAP_AFTER_ONE;
  const from = takeOver(fill);
  const to = Math.max(target, from);
  running = animateFill(fill, from, to, Math.max(cap, Math.min(0.94, to + 0.08)));
}

/**
 * Everything is in: fill the bar, then fade the splash.
 *
 * The splash is hidden, not removed: the node belongs to the server-rendered
 * layout, and pulling it out from under React can break a later reconcile.
 */
export function finishSplash(): void {
  if (finished || typeof document === "undefined") return;
  finished = true;
  const parts = splashParts();
  if (!parts) return;
  const { splash, fill } = parts;
  splash.dataset.stage = "done";

  const hide = () => {
    splash.classList.add("is-done");
    // Once faded, take it out of rendering so its loops stop ticking.
    window.setTimeout(() => splash.classList.add("is-gone"), FADE_MS + 50);
  };
  if (!fill) {
    hide();
    return;
  }
  const from = takeOver(fill);
  running = animateFill(fill, from, 1, null);
  // A timer rather than the animation's `finished` promise: animations can
  // be held in a background tab, and the splash must lift regardless.
  window.setTimeout(hide, from >= 0.999 ? 0 : FINISH_MS - 40);
}
