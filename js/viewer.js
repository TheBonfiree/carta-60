/* ---------------------------------------------------------------------------
 * viewer.js — the one real-time section on the page
 *
 * Everything else on this site is pre-rendered playback: the hero is a still,
 * and the assembly section scrubs decoded WebP frames onto a 2D canvas. This
 * module is the exception — an actual WebGL scene the visitor can grab.
 *
 * Three things shape the design:
 *
 * 1. It must not cost anything until it is wanted. Three.js is ~750 KB of
 *    vendored module, which is larger than every other script on the page put
 *    together. So it is behind a dynamic import() fired by an
 *    IntersectionObserver: a visitor who never scrolls this far never pays for
 *    it, and the loading screen never waits on it.
 *
 * 2. The render loop must not run when nobody is looking at it. Same observer
 *    stops it on the way out; visibilitychange stops it on tab switch. An
 *    idling WebGL loop is a battery leak on a page that is otherwise static.
 *
 * 3. Framing has to be derived, never hardcoded. Camera distance comes from the
 *    model's own bounding sphere and the camera FOV, so the shot is correct
 *    regardless of what scale the .glb happens to be exported at — and all of
 *    it resolves before the first render, so the model never flashes
 *    off-centre.
 * ------------------------------------------------------------------------- */

import { modelSrc, prefersReducedMotion } from './config.js';

/* Tuning ------------------------------------------------------------------*/

const FOV = 35;               // Long-ish lens: less perspective distortion on
                              // a wide, flat object than the usual 50.
const FIT_PADDING = 1.12;     // Breathing room around the fitted silhouette.
const ZOOM_MIN = 0.55;        // Closest/furthest, as fractions of fit distance.
const ZOOM_MAX = 2.2;
const ZOOM_STEP = 1.18;       // Per click of the +/- buttons.
const AUTOROTATE_SPEED = 0.6;
const IDLE_RESUME_MS = 4000;  // Inactivity before auto-rotate picks back up.

/* Start slightly above and off-axis — a three-quarter view reads as a product
 * shot, where a straight-on one reads as a diagram. */
const START_AZIMUTH = Math.PI * 0.22;
const START_POLAR = Math.PI * 0.34;

/* Never let the board flip under its own contact shadow, and never let it go
 * fully top-down either — both look like bugs. */
const POLAR_MIN = Math.PI * 0.12;
const POLAR_MAX = Math.PI * 0.49;

/* ------------------------------------------------------------------------ */

/** Read a design token so the WebGL clear colour matches the page exactly.
 *  Same approach as scroll.js, which paints its canvas letterbox this way. */
function token(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Cheap WebGL support probe. Creates a throwaway context and releases it. */
function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext &&
      (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

/**
 * A soft radial gradient painted into a canvas and laid flat under the model.
 *
 * Deliberately not a real shadow map: a PCF shadow from a single key light on
 * a 13k-tri mesh costs a whole extra render pass per frame and still lands
 * harder-edged than the site's look. The rest of the page's imagery is
 * alpha-feathered onto a soft studio ground (see build-assets.sh), and this
 * matches that treatment for free.
 */
function makeContactShadow(THREE, radius) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;

  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(20,18,14,0.34)');
  g.addColorStop(0.45, 'rgba(20,18,14,0.16)');
  g.addColorStop(1, 'rgba(20,18,14,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 3.4, radius * 3.4),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,   // Never occludes the model.
      toneMapped: false,   // Keep it a flat blend, not a lit surface.
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -1;

  return mesh;
}

/**
 * Build and run the scene. Called at most once, from the observer below.
 * Returns a teardown function.
 */
async function createViewer(section) {
  const frame = section.querySelector('[data-viewer-frame]');
  const bar = section.querySelector('[data-viewer-bar]');
  const canvas = section.querySelector('[data-viewer-canvas]');

  /* Surface a failure in the frame itself. A blank rectangle reads as a broken
   * page; a sentence reads as a known limitation. */
  const fail = (msg) => {
    frame.classList.add('is-failed');
    const el = section.querySelector('[data-viewer-error]');
    if (el) el.textContent = msg;
  };

  if (!hasWebGL()) {
    fail('Your browser doesn’t support WebGL, so the live model can’t run here.');
    return null;
  }

  /* ── Load three, lazily ─────────────────────────────────────────────────
   * Resolved through the import map in index.html, which points the bare
   * specifier "three" at the vendored build. Parallel, since the addons only
   * need "three" itself to have been *requested*, not awaited in order. */
  let THREE, GLTFLoader, OrbitControls, RoomEnvironment;
  try {
    [THREE, { GLTFLoader }, { OrbitControls }, { RoomEnvironment }] = await Promise.all([
      import('three'),
      import('../vendor/three/jsm/loaders/GLTFLoader.js'),
      import('../vendor/three/jsm/controls/OrbitControls.js'),
      import('../vendor/three/jsm/environments/RoomEnvironment.js'),
    ]);
  } catch {
    fail('The 3D viewer failed to load. Everything else on this page still works.');
    return null;
  }

  /* ── Renderer ───────────────────────────────────────────────────────────*/
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  // Capped at 2: past that the extra pixels cost fill rate and buy nothing
  // visible. Same cap the assembly canvas uses.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  /* Neutral (Khronos PBR Neutral), not ACES.
   *
   * ACES is a film curve: it desaturates as values climb toward white, which
   * is flattering on a lit scene and actively wrong on a product in pale
   * beige. Measured off the render, it collapsed the keycaps from 19 points of
   * channel spread in the source texture to 5 on screen — the beige arrived as
   * grey, and no amount of retinting the texture could fix it, because the
   * curve was removing the warmth after the fact.
   *
   * Neutral exists for this exact case: it preserves hue and saturation up to
   * the point of clipping, so the albedo that goes in is the colour that comes
   * out. */
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(new THREE.Color(token('--c-bg', '#f4f2ee')), 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 1000);

  /* ── Lighting ───────────────────────────────────────────────────────────
   * RoomEnvironment through PMREM gives real image-based lighting, which is
   * what makes beige PBT and bead-blasted aluminium read as those materials
   * rather than as grey plastic. The generator is disposed immediately — it is
   * scaffolding for producing the cubemap, not part of the running scene. */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.72;
  pmrem.dispose();

  /* A soft key on top of the environment, for directional shaping. Kept
   * moderate: the sole job of the direct light here is to put a gradient
   * across the keycap tops so the board has form. Any stronger and it flattens
   * the beige into white, which is the one failure mode this palette has. */
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(2.5, 4, 3);
  scene.add(key);

  // Warm bounce from below, so the underside of the case never goes grey.
  const fill = new THREE.HemisphereLight(0xffffff, 0xd8d2c6, 0.45);
  scene.add(fill);

  /* ── Controls ───────────────────────────────────────────────────────────*/
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;       // Pan lets the user lose the model offscreen.
  controls.minPolarAngle = POLAR_MIN;
  controls.maxPolarAngle = POLAR_MAX;
  controls.rotateSpeed = 0.85;
  controls.zoomSpeed = 0.8;
  controls.autoRotateSpeed = AUTOROTATE_SPEED;

  /* ── Load the model ─────────────────────────────────────────────────────*/
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().load(
      modelSrc(),
      resolve,
      (e) => {
        // Only meaningful when the server sends Content-Length; otherwise the
        // bar just holds at 0 until the load resolves and we snap it to 1.
        if (bar && e.lengthComputable) {
          // Transform, not width — never triggers layout. Matches .loader__bar.
          bar.style.transform = `scaleX(${e.loaded / e.total})`;
        }
      },
      reject
    );
  }).catch(() => null);

  if (!gltf) {
    fail('The model couldn’t be loaded. Everything else on this page still works.');
    renderer.dispose();
    return null;
  }

  const model = gltf.scene;

  /* ── Centring, pivot and framing ────────────────────────────────────────
   * Order matters, and all of it happens before the first render.
   *
   * The failure this avoids: orbiting around world origin when the model's own
   * origin is somewhere else entirely (Sketchfab exports are routinely offset,
   * and this one is). The board then swings around a point out in space
   * instead of turning in place. Recentring the geometry — rather than just
   * pointing the controls at the centre — also means the contact shadow, the
   * zoom limits and the camera framing can all assume origin, so there is only
   * one place that can be wrong. */
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);                 // geometric centre -> world origin
  scene.add(model);

  // Re-measure post-translation rather than trusting the pre-move numbers.
  const centered = new THREE.Box3().setFromObject(model);
  const size = centered.getSize(new THREE.Vector3());
  const radius = centered.getBoundingSphere(new THREE.Sphere()).radius;

  /* Framing.
   *
   * The obvious approach — fit the bounding SPHERE to the vertical FOV — is
   * rotation-safe but badly wrong for this shape. A keyboard is wide, deep and
   * almost flat, so its bounding sphere is driven by the long diagonal and is
   * enormously larger than the board's apparent height. Fitting that sphere
   * pushed the camera so far back the model sat at roughly a third of the
   * frame, marooned in whitespace.
   *
   * Since the model only ever rotates about Y, its silhouette from ANY azimuth
   * is contained by a cylinder: radius = the XZ half-diagonal, height = the
   * model's own height. Fitting that cylinder instead is just as safe against
   * rotation, and far tighter.
   *
   * The vertical extent depends on the camera's polar angle, so we evaluate
   * the worst case across the whole permitted polar range — the shot stays
   * correct wherever the visitor tilts to, not just at the opening angle. */
  const rXZ = Math.hypot(size.x, size.z) / 2;   // worst-case horizontal radius
  const hY = size.y / 2;

  // Projected vertical half-extent of that cylinder at polar angle t.
  const verticalExtent = (t) => rXZ * Math.cos(t) + hY * Math.sin(t);

  const vFov = (FOV / 2) * (Math.PI / 180);
  const aspect = Math.max(frame.clientWidth / frame.clientHeight, 0.1);
  const hFov = Math.atan(Math.tan(vFov) * aspect);

  // Distance at which the cylinder fits the frame, viewed from polar angle t.
  const fitAt = (t) => Math.max(
    verticalExtent(t) / Math.tan(vFov),   // constrained by frame height
    rXZ / Math.tan(hFov)                  // constrained by frame width
  ) * FIT_PADDING;

  /* Two different distances, for two different jobs.
   *
   * Framing for the WORST polar angle keeps the model in frame no matter how
   * the visitor tilts — but a near-top-down view presents the board's full
   * diagonal vertically, which is roughly twice the extent of the opening
   * three-quarter view. Framing for that case leaves the default shot small
   * and stranded in whitespace, which is what it looked like at first.
   *
   * So: open at the distance that suits the opening angle, and let the zoom
   * range reach back far enough to cover the worst case. Auto-rotate only ever
   * changes azimuth, never polar, so the idle view cannot drift into clipping
   * on its own — only a deliberate tilt gets near it, and the visitor can
   * zoom out from there. */
  const peak = THREE.MathUtils.clamp(Math.atan2(hY, rXZ), POLAR_MIN, POLAR_MAX);
  const worstFit = Math.max(fitAt(peak), fitAt(POLAR_MIN), fitAt(POLAR_MAX));
  const startFit = fitAt(START_POLAR);

  controls.minDistance = startFit * ZOOM_MIN;
  controls.maxDistance = Math.max(startFit * ZOOM_MAX, worstFit * 1.1);

  // Spherical -> cartesian for the opening three-quarter view.
  camera.position.setFromSphericalCoords(startFit, START_POLAR, START_AZIMUTH);
  camera.near = Math.max(startFit / 100, 0.01);
  camera.far = controls.maxDistance * 4;

  controls.target.set(0, 0, 0);   // == model centre, after the translate above
  controls.update();

  // Sit the shadow just under the model's actual underside.
  const shadow = makeContactShadow(THREE, radius);
  shadow.position.y = centered.min.y - radius * 0.02;
  scene.add(shadow);

  /* ── Sizing ─────────────────────────────────────────────────────────────*/
  function resize() {
    const { width, height } = frame.getBoundingClientRect();
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }
  resize();

  // ResizeObserver rather than window.resize: the frame is a grid child whose
  // height can change without the window doing anything at all.
  const ro = new ResizeObserver(resize);
  ro.observe(frame);

  /* ── Idle auto-rotate ───────────────────────────────────────────────────
   * Off entirely under reduced motion — unprompted continuous movement is
   * exactly what that preference is asking us not to do. */
  const reduce = prefersReducedMotion();
  let idleTimer = 0;
  controls.autoRotate = !reduce;

  controls.addEventListener('start', () => {
    controls.autoRotate = false;
    clearTimeout(idleTimer);
  });
  controls.addEventListener('end', () => {
    if (reduce) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { controls.autoRotate = true; }, IDLE_RESUME_MS);
  });

  /* ── Zoom buttons ───────────────────────────────────────────────────────
   * Routed through the same controls object as wheel and pinch, so there is a
   * single clamped zoom path and the buttons cannot disagree with the scroll
   * wheel about where the limits are. */
  const zoomBy = (factor) => {
    const offset = camera.position.clone().sub(controls.target);
    const next = THREE.MathUtils.clamp(
      offset.length() * factor, controls.minDistance, controls.maxDistance
    );
    camera.position.copy(controls.target).add(offset.setLength(next));
    controls.update();
    // Treat a button press as interaction, exactly like a drag.
    controls.autoRotate = false;
    clearTimeout(idleTimer);
    if (!reduce) {
      idleTimer = setTimeout(() => { controls.autoRotate = true; }, IDLE_RESUME_MS);
    }
  };

  const onZoomClick = (e) => {
    const btn = e.currentTarget;
    zoomBy(btn.dataset.viewerZoom === 'in' ? 1 / ZOOM_STEP : ZOOM_STEP);
  };
  const zoomButtons = Array.from(section.querySelectorAll('[data-viewer-zoom]'));
  zoomButtons.forEach((b) => b.addEventListener('click', onZoomClick));

  /* ── Render loop ────────────────────────────────────────────────────────
   * Started and stopped from outside. Damping means we cannot render on
   * demand — the controls keep easing for a beat after input stops — so the
   * loop runs continuously while visible, and not at all otherwise. */
  let rafId = 0;
  let running = false;

  function tick() {
    rafId = requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  }

  function start() {
    if (running) return;
    running = true;
    tick();
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(rafId);
  }

  /* A backgrounded tab already throttles rAF, but stopping outright also drops
   * the GPU work rather than merely slowing it. */
  const onVisibility = () => {
    if (document.hidden) stop();
    else if (section.dataset.viewerVisible === 'true') start();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Paint one frame and reveal only now that framing is fully resolved — this
  // is what guarantees the model is never seen off-centre or mid-fit.
  renderer.render(scene, camera);
  if (bar) bar.style.transform = 'scaleX(1)';
  frame.classList.add('is-ready');

  /* ── Teardown ───────────────────────────────────────────────────────────
   * The page never unmounts this, but an undisposable viewer is a viewer that
   * cannot be reused, and GPU resources are not garbage-collected. */
  function destroy() {
    stop();
    clearTimeout(idleTimer);
    ro.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    zoomButtons.forEach((b) => b.removeEventListener('click', onZoomClick));
    controls.dispose();

    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.geometry?.dispose();
      for (const mat of [].concat(obj.material || [])) {
        // Every texture-ish property on the material, whatever it is called.
        for (const value of Object.values(mat)) {
          if (value && value.isTexture) value.dispose();
        }
        mat.dispose();
      }
    });

    envRT.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }

  return { start, stop, destroy };
}

/**
 * Register the lazy-init observer and return immediately.
 *
 * Non-blocking by design: main.js calls this during boot, and it must not
 * delay anything. All the real work happens the first time the section comes
 * within 200px of the viewport.
 */
export function initViewer() {
  const section = document.querySelector('[data-viewer]');
  if (!section || !('IntersectionObserver' in window)) return;

  let viewer = null;    // resolved instance, once built
  let building = false; // guards against a second build during the await

  const observer = new IntersectionObserver(
    async (entries) => {
      const entry = entries[0];
      section.dataset.viewerVisible = String(entry.isIntersecting);

      if (!entry.isIntersecting) {
        viewer?.stop();
        return;
      }

      if (viewer) { viewer.start(); return; }
      if (building) return;

      building = true;
      viewer = await createViewer(section);
      // Might have scrolled away during the load; only run if still wanted.
      if (viewer && section.dataset.viewerVisible === 'true') viewer.start();
    },
    // 200px lead time so the fetch and first frame land before it is on screen.
    { rootMargin: '200px 0px' }
  );

  observer.observe(section);
}
