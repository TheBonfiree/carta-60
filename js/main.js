/* ---------------------------------------------------------------------------
 * main.js — boot order
 *
 * The loader must finish before scroll.js runs: the scrub depends on frames
 * being decoded, and ScrollTrigger needs to measure a laid-out page rather
 * than one still behind the loading screen.
 * ------------------------------------------------------------------------- */

import { runLoader } from './loader.js';
import { initForm } from './form.js';
import { initScroll } from './scroll.js';
import { initUI } from './ui.js';
import { initViewer } from './viewer.js';

async function boot() {
  await runLoader();
  initScroll();
  initUI();
  // Binds listeners only — no fetching and no layout reads, so it cannot
  // perturb ScrollTrigger's measurements or delay the loader handoff.
  initForm();
  // Registers an IntersectionObserver and returns — it neither fetches
  // Three.js nor touches WebGL until the 3D section is actually approached, so
  // it costs nothing here and cannot delay the loader handoff.
  initViewer();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
