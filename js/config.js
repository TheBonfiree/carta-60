/* ---------------------------------------------------------------------------
 * config.js — single source of truth
 *
 * Brand strings, asset paths and the frame count all live here. Renaming the
 * product or re-extracting the assembly sequence at a different length should
 * never require touching another file.
 * ------------------------------------------------------------------------- */

export const BRAND = {
  wordmark: 'CARTA',
  product: 'CARTA 60',
};

/* Assembly frame sequence -------------------------------------------------
 * FRAME_COUNT must match the number of files actually present in
 * assets/assembly/. If you re-extract with a different fps, update this
 * number and nothing else. See README for the ffmpeg command.
 *
 * Mobile uses a halved set (every other frame, smaller) to keep both the
 * download and the decoded-bitmap memory footprint sane on phones.
 */
export const FRAMES = {
  // 97 = every real frame of the 4.04s / 24fps master. Deliberately not
  // resampled up to a round number: duplicated frames read as stutter.
  count: 97,
  path: 'assets/assembly/',
  prefix: 'frame_',
  ext: '.webp',
  pad: 4,

  // Mobile: half the frames, half the pixels.
  mobileCount: 49,
  mobilePath: 'assets/assembly-mobile/',
};

export const ASSETS = {
  hero: 'assets/hero/hero.webp',
  heroSmall: 'assets/hero/hero@1200.webp',
};

/* Real-time 3D model ------------------------------------------------------
 * The only asset on the page that is not pre-rendered. Two variants differing
 * ONLY in texture resolution (2048 / 1024) — the geometry is identical and
 * trivially cheap at ~13.7k triangles, so there is no low-poly mobile build
 * and no reason for one. See build-model.sh.
 *
 * `poster` is the still shown when WebGL is unavailable or the model fails to
 * load, so the frame is never blank.
 */
export const MODEL = {
  desktop: 'assets/model/carta60.glb',
  mobile: 'assets/model/carta60@1024.glb',
  poster: 'assets/model/poster.webp',
};

/* Lead capture -----------------------------------------------------------
 * Netlify Forms. There is no endpoint URL to configure and no API key: the
 * form POSTs to the site's OWN origin, and Netlify's edge intercepts any POST
 * carrying a `form-name` it detected in the deployed HTML. Nothing here is a
 * secret, and moving hosts is the only thing that would change it.
 *
 * `name` must match the form's name= attribute in index.html; Netlify keys the
 * submission store on that string.
 */
export const FORM = {
  name: 'early-access',
  endpoint: '/',

  // Secondary capture: a Netlify Function that pushes the lead into Airtable
  // server-side. The Airtable token lives in the function's env, never here —
  // this is only a same-origin URL path, which exposes nothing.
  airtableEndpoint: '/.netlify/functions/submit-lead',

  // serve.js is a static file server and answers POST with a 404, so the
  // success state is unreachable locally. Flip to true to skip the network and
  // land straight on it while styling — MUST be false in anything deployed.
  devEcho: false,
};

/* Breakpoint at which we switch to the reduced frame set. Kept as a media
 * query string so CSS and JS agree on one number. */
export const MOBILE_QUERY = '(max-width: 768px)';

/* Loader will release even if decoding is still in flight after this long, so
 * a slow connection degrades to a coarse scrub rather than a stuck screen. */
export const LOADER_TIMEOUT_MS = 8000;

/* ---------------------------------------------------------------------------
 * Derived helpers
 * ------------------------------------------------------------------------- */

export const isMobile = () => window.matchMedia(MOBILE_QUERY).matches;

export const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Total frames for the current device. */
export const frameCount = () => (isMobile() ? FRAMES.mobileCount : FRAMES.count);

/**
 * URL for frame `i` (0-based) on the current device.
 * The mobile set is extracted as its own contiguous 0..59 sequence, so the
 * index needs no remapping — only the directory changes.
 */
export const frameSrc = (i) => {
  const dir = isMobile() ? FRAMES.mobilePath : FRAMES.path;
  return `${dir}${FRAMES.prefix}${String(i).padStart(FRAMES.pad, '0')}${FRAMES.ext}`;
};

/**
 * Model variant for the current device. Read once, when the viewer lazily
 * initialises — not on resize. Swapping the GLB mid-session would mean a
 * second multi-hundred-KB download to change nothing but texture resolution.
 */
export const modelSrc = () => (isMobile() ? MODEL.mobile : MODEL.desktop);
