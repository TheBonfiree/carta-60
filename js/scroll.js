/* ---------------------------------------------------------------------------
 * scroll.js — pinned canvas scrub + section reveals
 *
 * Why a canvas frame sequence and not <video>:
 *   Setting video.currentTime forces the decoder to seek to the preceding
 *   keyframe and decode forward to the target on every scroll tick. Forward
 *   scrubbing is merely uneven; reverse scrubbing is pathological, because
 *   each step backwards re-decodes from an earlier keyframe. Pre-decoded
 *   frames blitted with drawImage() have no per-tick decode cost at all and
 *   reverse exactly as cheaply as they advance.
 * ------------------------------------------------------------------------- */

import { frames } from './loader.js';
import { frameCount, prefersReducedMotion } from './config.js';

/** Nearest frame that actually decoded — a timed-out load coarsens the scrub
 * rather than punching a blank hole in it. */
function nearestFrame(i) {
  if (frames[i]) return frames[i];
  const count = frameCount();
  for (let d = 1; d < count; d++) {
    if (frames[i - d]) return frames[i - d];
    if (frames[i + d]) return frames[i + d];
  }
  return null;
}

/**
 * Wire up the pinned assembly section.
 * Returns early (leaving the last frame painted) under reduced motion.
 */
function initAssembly() {
  const canvas = document.querySelector('[data-assembly-canvas]');
  const section = document.querySelector('[data-assembly]');
  if (!canvas || !section) return;

  const ctx = canvas.getContext('2d', { alpha: false });
  const count = frameCount();

  let current = -1;   // last frame index actually painted
  let target = 0;     // frame index the scroll position asks for
  let queued = false; // rAF already scheduled?

  /* Size the backing store to the device pixel ratio, capped at 2 — beyond
   * that the extra pixels cost fill rate and buy nothing visible. Called on
   * resize only, never during scroll. */
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    current = -1; // force a repaint at the new size
    draw();
  }

  /* Paint `target`, letterboxed to preserve the render's aspect ratio. */
  function draw() {
    queued = false;
    if (target === current) return;

    const img = nearestFrame(target);
    if (!img) return;
    current = target;

    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;

    // Background matches the page so the letterbox is invisible.
    ctx.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--c-bg')
      .trim() || '#f4f2ee';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  /* Coalesce: several scroll events inside one frame produce one paint. */
  function requestDraw() {
    if (!queued) {
      queued = true;
      requestAnimationFrame(draw);
    }
  }

  resize();
  window.addEventListener('resize', resize);

  /* Reduced motion: no pin, no scrub — just the assembled result. */
  if (prefersReducedMotion()) {
    target = count - 1;
    draw();
    section.classList.add('is-static');
    return;
  }

  const state = { progress: 0 };

  gsap.to(state, {
    progress: 1,
    ease: 'none',
    scrollTrigger: {
      trigger: section,
      start: 'top top',
      end: '+=250%',
      pin: true,
      // Smoothing: scrub takes 0.6s to catch up to the scroll position, which
      // absorbs trackpad jitter without feeling laggy.
      scrub: 0.6,
      anticipatePin: 1,
      onUpdate: (self) => {
        // The cue is only relevant before the assembly is underway.
        section.classList.toggle('is-scrubbing', self.progress > 0.08);
      },
    },
    onUpdate: () => {
      target = Math.min(count - 1, Math.round(state.progress * (count - 1)));
      requestDraw();
    },
  });
}

/** Fade/rise reveals for the detail blocks. Transform + opacity only. */
function initReveals() {
  if (prefersReducedMotion()) {
    document.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('is-in'));
    return;
  }

  document.querySelectorAll('[data-reveal]').forEach((el) => {
    gsap.fromTo(
      el,
      { opacity: 0, y: 40 },
      {
        opacity: 1,
        y: 0,
        duration: 0.9,
        ease: 'power2.out',
        scrollTrigger: { trigger: el, start: 'top 80%', once: true },
      }
    );
  });
}

export function initScroll() {
  gsap.registerPlugin(ScrollTrigger);
  initAssembly();
  initReveals();
  ScrollTrigger.refresh();
}
