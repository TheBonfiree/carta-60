/* ---------------------------------------------------------------------------
 * loader.js — real asset progress
 *
 * The progress bar is tied to actual decode completion, not a timer. Order
 * matters: the hero image is decoded first so the reveal is never empty, then
 * the assembly frames stream in behind it.
 *
 * Exports the decoded frame array so scroll.js never re-fetches anything —
 * every frame is an already-decoded HTMLImageElement by the time the scrub
 * runs, which is what keeps drawImage() free of per-tick decode cost.
 * ------------------------------------------------------------------------- */

import {
  ASSETS,
  LOADER_TIMEOUT_MS,
  frameCount,
  frameSrc,
  isMobile,
  prefersReducedMotion,
} from './config.js';

/** Sparse array of decoded frames; holes are frames that failed or timed out. */
export const frames = [];

/**
 * Decode a single image. Resolves with the element on success, `null` on
 * failure — a missing frame must never reject the whole load.
 */
function decodeImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;

    // decode() gives us a genuine "ready to paint" signal; onload alone can
    // still leave the first drawImage() paying decode cost on the main thread.
    const done = () => resolve(img);
    if (img.decode) {
      img.decode().then(done).catch(() => resolve(img.complete ? img : null));
    } else {
      img.onload = done;
      img.onerror = () => resolve(null);
    }
  });
}

/**
 * Run the loading sequence, driving the progress bar, then hand off to the
 * hero. Resolves once the handoff animation has started.
 *
 * @returns {Promise<void>}
 */
export async function runLoader() {
  const root = document.querySelector('[data-loader]');
  const bar = document.querySelector('[data-loader-bar]');
  const total = frameCount() + 1; // +1 for the hero still
  let done = 0;

  // Written as a transform (scaleX) rather than width so the bar animates on
  // the compositor and never triggers layout.
  const setProgress = (v) => {
    if (bar) bar.style.transform = `scaleX(${v})`;
  };
  const tick = () => setProgress(++done / total);

  /* Repeat visits skip the full sequence — the assets are cached, so holding
   * the visitor at a loading screen a second time is theatre. */
  const seen = sessionStorage.getItem('carta:loaded') === '1';

  // 1. Hero first, so there is something behind the fade the instant it lifts.
  //    Match the srcset choice so a phone never pulls the 2400px version.
  await decodeImage(isMobile() ? ASSETS.heroSmall : ASSETS.hero);
  tick();

  // 2. Frames, in parallel, with a hard ceiling on how long we wait.
  const count = frameCount();
  const loading = Array.from({ length: count }, (_, i) =>
    decodeImage(frameSrc(i)).then((img) => {
      if (img) frames[i] = img;
      tick();
    })
  );

  const timeout = new Promise((r) => setTimeout(r, LOADER_TIMEOUT_MS));
  await Promise.race([Promise.all(loading), timeout]);

  // Whatever happened, the bar completes — a bar that stops at 70% and lifts
  // anyway reads as broken.
  setProgress(1);

  sessionStorage.setItem('carta:loaded', '1');

  // 3. Handoff. Reduced motion and repeat visits both cut straight through.
  const instant = seen || prefersReducedMotion();
  await new Promise((r) => setTimeout(r, instant ? 0 : 200));

  root?.classList.add('is-complete');
  document.documentElement.classList.add('is-loaded');

  // Remove from the a11y tree and the paint path once faded.
  setTimeout(() => root?.remove(), instant ? 0 : 900);
}
