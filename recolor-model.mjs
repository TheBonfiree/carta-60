/* ---------------------------------------------------------------------------
 * recolor-model.mjs — repaint the source model into the CARTA 60 palette
 *
 *   node recolor-model.mjs [in.glb] [out.glb]
 *
 * Run by build-model.sh before optimisation. Reads the palette straight out of
 * css/base.css so this file and the site cannot drift apart.
 *
 * WHY THIS EXISTS
 *
 *   The supplied model is a green-and-white Sketchfab keyboard. Every other
 *   section of the site is beige PBT on off-white aluminium, and the two sat
 *   badly together — the one live element on the page looked like a different
 *   product.
 *
 * WHY TEXTURES AND NOT MATERIALS
 *
 *   The colour is baked into the base-colour maps, not into material factors,
 *   so tinting `material.color` at runtime cannot remove it — it would only
 *   multiply green by beige and yield mud. Overriding the maps with flat
 *   colours works, but throws away the keycap legends, the panel seams and the
 *   surface shading, which is most of what sells it as a real object.
 *
 *   So we repaint the two base-colour maps directly, in place, preserving
 *   per-pixel luminance variation. Detail survives; only hue changes.
 *
 * THE ONE INTERESTING PROBLEM
 *
 *   The keycap atlas uses the SAME green for two different things: large solid
 *   accent keycaps, and hairline legends printed on the cream caps. A single
 *   target colour cannot serve both — anything light enough to read as an
 *   accent keycap turns the legends into illegible smudges on cream.
 *
 *   They are indistinguishable by colour, but trivially separable by SHAPE: an
 *   accent keycap is a large solid field, a legend is a thin stroke. So we
 *   classify each green pixel by how green its neighbourhood is, using a
 *   summed-area table (O(1) per pixel regardless of radius), and send solid
 *   fields and thin strokes to different targets.
 *
 * No dependencies: pixel access goes through ffmpeg, which this project
 * already requires for build-assets.sh.
 * ------------------------------------------------------------------------- */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IN = process.argv[2] || 'assets/reference/keyboard-master.glb';
const OUT = process.argv[3] || 'assets/reference/keyboard-carta.glb';

/* ── Palette ──────────────────────────────────────────────────────────────
 * Pulled from the stylesheet rather than duplicated, so retuning the site's
 * tokens retunes the model too. */
function readTokens(file) {
  const css = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const [, k, v] of css.matchAll(/--(c-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[k] = v;
  return out;
}

const T = readTokens('css/base.css');
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/* Targets sit slightly BELOW their token values.
 *
 * These are albedo, not pixels — a lit scene adds on top of whatever goes in,
 * so feeding the literal token straight in renders lighter than the token. The
 * margin here is small and deliberate: it was much larger while the renderer
 * still used ACES tone mapping, to claw back the warmth that curve removed.
 * Now that the viewer uses Neutral, which preserves saturation, the albedo
 * arrives on screen almost intact and only needs a little headroom. */
const TARGET = {
  // Cream keycaps -> the site's own keycap beige.
  cap: hex(T['c-keycap']).map((v) => Math.round(v * 0.95)),

  // Solid accent keycaps -> the site's sand accent, used as-is. base.css
  // describes it as "a desaturated sand that sits inside the product's own
  // colour range rather than fighting it", which is exactly the job here.
  // Darkening it at all pushes it towards olive, which fights everything.
  accent: hex(T['c-accent']),

  // Legends -> near-ink. These are 1–2 px strokes on cream; they need real
  // contrast or the board reads as blank keycaps.
  legend: [43, 41, 38],

  // The aluminium case. Kept clearly lighter and cooler than the caps — that
  // gap is the whole reason the product reads as "beige PBT ON off-white
  // aluminium" rather than as one undifferentiated cream object.
  case: hex(T['c-case']).map((v) => Math.round(v * 0.94)),
};

/* ── Pixel plumbing via ffmpeg ────────────────────────────────────────────*/

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carta-recolor-'));

/** Decode any image file to a flat RGB24 buffer. */
function decode(file) {
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', file,
  ]).toString());
  const { width, height } = probe.streams[0];
  const raw = execFileSync('ffmpeg', [
    '-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 1 << 30 });
  return { data: raw, width, height };
}

/** Encode a flat RGB24 buffer back to PNG (lossless — build-model.sh converts
 *  the result to WebP afterwards, so compressing twice would only lose data). */
function encodePNG({ data, width, height }, outFile) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', '-',
    '-frames:v', '1', outFile,
  ], { input: data, maxBuffer: 1 << 30 });
  return fs.readFileSync(outFile);
}

/* ── Colour helpers ───────────────────────────────────────────────────────*/

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Is this pixel part of the model's green? Green here always has g above
 *  both r and b by a clear margin; the cream has r above g, so it never
 *  matches and never needs an explicit exclusion. */
const isGreen = (r, g, b) => g > r && g > b && g - Math.max(r, b) > 6;

/**
 * Recolour one class of pixels to `target`, keeping their internal shading.
 *
 * Each pixel's luminance is expressed as a ratio against the class median,
 * then that ratio — damped, so a near-black source cannot drive the target to
 * black — is reapplied to the target colour. Flat areas come out flat, and
 * seams, bevels and dirt survive as the same relative light and shade.
 */
function repaint(px, indices, target, damping = 0.55) {
  if (!indices.length) return;

  const lums = new Float64Array(indices.length);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    lums[k] = luma(px[i], px[i + 1], px[i + 2]);
  }
  const median = lums.slice().sort()[lums.length >> 1] || 1;

  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    // Damped shading ratio: 1 means "the class average", and deviations are
    // compressed so texture reads as texture rather than as blotches.
    const s = 1 + (lums[k] / median - 1) * damping;
    px[i]     = Math.max(0, Math.min(255, Math.round(target[0] * s)));
    px[i + 1] = Math.max(0, Math.min(255, Math.round(target[1] * s)));
    px[i + 2] = Math.max(0, Math.min(255, Math.round(target[2] * s)));
  }
}

/**
 * Split green pixels into accent keycaps and printed legends.
 *
 * A summed-area table over the green mask makes "what fraction of the r-radius
 * box around this pixel is also green?" a four-lookup constant-time query, so
 * the radius can be generous without the cost exploding.
 *
 * The test is deliberately WIDE and permissive rather than narrow and strict.
 * A strict local test ("is this pixel surrounded by green?") looks right until
 * it meets the botanical line-art printed on the accent keys: those are cream
 * outlines enclosing small green interiors, and every one of those interiors
 * fails a local solidity test, gets filed as a legend, and comes out black.
 *
 * What actually separates the two cases is the neighbourhood at KEYCAP scale,
 * not stroke scale: a legend printed on a cream cap sits in a field that is
 * overwhelmingly cream, while any green inside an accent key — enclosed by
 * line-art or not — sits in a field that is mostly green.
 *
 *   pass 1  ratio >= FIELD over a wide radius -> belongs to an accent keycap
 *   pass 2  dilate slightly                   -> recovers the keycap's own
 *                                                edges and corners, which sit
 *                                                in half- and quarter-empty
 *                                                boxes and would otherwise
 *                                                leave every cap outlined in
 *                                                legend colour
 */
function classifyGreen(px, width, height) {
  const n = width * height;
  const mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 3;
    if (isGreen(px[i], px[i + 1], px[i + 2])) mask[p] = 1;
  }

  // Integral image, one row and column of zero padding.
  const W = width + 1;
  const integral = (m) => {
    const sat = new Int32Array(W * (height + 1));
    for (let y = 0; y < height; y++) {
      let row = 0;
      for (let x = 0; x < width; x++) {
        row += m[y * width + x];
        sat[(y + 1) * W + (x + 1)] = sat[y * W + (x + 1)] + row;
      }
    }
    return sat;
  };
  const boxSum = (sat, x0, y0, x1, y1) =>
    sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0];

  const R = Math.max(8, Math.round(width / 85));   // ~24 px at 2048 — keycap scale
  const FIELD = 0.45;
  // Edge recovery, plus enough reach to swallow the few tiny green islands
  // trapped inside the densest line-art, which are locally cream-majority even
  // at keycap scale and would otherwise survive as black specks.
  const RD = Math.max(4, Math.round(width / 146)); // ~14 px at 2048

  const sat1 = integral(mask);
  const field = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(height, y + R + 1);
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!mask[p]) continue;
      const x0 = Math.max(0, x - R), x1 = Math.min(width, x + R + 1);
      const area = (x1 - x0) * (y1 - y0);
      if (boxSum(sat1, x0, y0, x1, y1) / area >= FIELD) field[p] = 1;
    }
  }

  // Dilate the field mask back out over the keycap edges.
  const sat2 = integral(field);
  const capIdx = [], legendIdx = [];
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - RD), y1 = Math.min(height, y + RD + 1);
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!mask[p]) continue;
      const x0 = Math.max(0, x - RD), x1 = Math.min(width, x + RD + 1);
      (boxSum(sat2, x0, y0, x1, y1) > 0 ? capIdx : legendIdx).push(p * 3);
    }
  }
  return { capIdx, legendIdx, mask };
}

/* ── GLB read / write ─────────────────────────────────────────────────────*/

function readGLB(file) {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;           // skip the BIN chunk header
  const binLen = buf.readUInt32LE(20 + jsonLen);
  return { json, bin: buf.slice(binStart, binStart + binLen) };
}

function writeGLB(file, json, bin) {
  const pad = (b, to, fill) => {
    const extra = (to - (b.length % to)) % to;
    return extra ? Buffer.concat([b, Buffer.alloc(extra, fill)]) : b;
  };
  const jsonChunk = pad(Buffer.from(JSON.stringify(json), 'utf8'), 4, 0x20);
  const binChunk = pad(bin, 4, 0);

  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);                                  // 'glTF'
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonChunk.length, 0);
  jsonHead.writeUInt32LE(0x4e4f534a, 4);                              // 'JSON'

  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binChunk.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4);                               // 'BIN'

  fs.writeFileSync(file, Buffer.concat([head, jsonHead, jsonChunk, binHead, binChunk]));
}

/* ── Main ─────────────────────────────────────────────────────────────────*/

const { json, bin } = readGLB(IN);

/** Pull an embedded image out to a file so ffmpeg can read it. */
function extract(imageIndex) {
  const img = json.images[imageIndex];
  const bv = json.bufferViews[img.bufferView];
  const ext = img.mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const file = path.join(tmp, `img${imageIndex}.${ext}`);
  fs.writeFileSync(file, bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
  return file;
}

/* Locate the base-colour map of each material by name, rather than assuming
 * texture indices — a re-export from Sketchfab could reorder them. */
const baseColorOf = (materialName) => {
  const m = json.materials.find((x) => x.name === materialName);
  if (!m) throw new Error(`material not found: ${materialName}`);
  const texIndex = m.pbrMetallicRoughness?.baseColorTexture?.index;
  if (texIndex === undefined) throw new Error(`no base colour map on ${materialName}`);
  return { material: m, image: json.textures[texIndex].source };
};

const keyboard = baseColorOf('Keyboard');   // keycap atlas
const body = baseColorOf('Wood_00');        // the case (misleading name, from the export)

const replacements = [];   // { imageIndex, png }

/* --- keycap atlas: three classes ---------------------------------------- */
{
  const img = decode(extract(keyboard.image));
  const px = img.data;
  const { capIdx, legendIdx, mask } = classifyGreen(px, img.width, img.height);

  const creamIdx = [];
  for (let p = 0; p < img.width * img.height; p++) if (!mask[p]) creamIdx.push(p * 3);

  repaint(px, creamIdx, TARGET.cap, 0.5);
  repaint(px, capIdx, TARGET.accent, 0.5);
  repaint(px, legendIdx, TARGET.legend, 0.3);

  const total = img.width * img.height;
  console.log(`  keycaps : ${(creamIdx.length / total * 100).toFixed(1)}% cream, ` +
              `${(capIdx.length / total * 100).toFixed(1)}% accent keys, ` +
              `${(legendIdx.length / total * 100).toFixed(1)}% legends`);

  replacements.push({
    imageIndex: keyboard.image,
    png: encodePNG(img, path.join(tmp, 'keycaps.png')),
  });
}

/* --- case: one class ----------------------------------------------------- */
{
  const img = decode(extract(body.image));
  const px = img.data;
  const idx = [];
  for (let p = 0; p < img.width * img.height; p++) idx.push(p * 3);
  repaint(px, idx, TARGET.case, 0.45);

  console.log(`  case    : recoloured to rgb(${TARGET.case.join(',')})`);

  replacements.push({
    imageIndex: body.image,
    png: encodePNG(img, path.join(tmp, 'case.png')),
  });
}

/* Material response.
 *
 * glTF defaults `metallicFactor` to 1.0 when the property is absent, and this
 * export omits it on both materials — so every surface was being shaded as
 * bare metal. On the keycaps that is not a subtle error: a metal surface takes
 * its colour from what it reflects rather than from its own albedo, which
 * desaturated the beige into grey. Measured off the render, the caps came back
 * with 9 points of spread between their channels where the source beige has
 * 22. It read as white plastic, and no amount of retinting the texture would
 * have fixed it, because the albedo was barely reaching the screen.
 *
 * Keycaps are dye-sublimated PBT — a dielectric, metalness 0. The case is
 * bead-blasted anodised aluminium: genuinely metal, but the anodising is a
 * diffuse coating, so it sits low rather than at 1. */
keyboard.material.pbrMetallicRoughness.metallicFactor = 0.0;
keyboard.material.pbrMetallicRoughness.roughnessFactor = 0.55;

body.material.pbrMetallicRoughness.metallicFactor = 0.25;
body.material.pbrMetallicRoughness.roughnessFactor = 0.62;

/* Append the new images as fresh bufferViews and repoint. The originals are
 * left orphaned rather than spliced out: rewriting every downstream offset by
 * hand is exactly the kind of thing that silently corrupts a mesh, and the
 * `prune` pass in build-model.sh drops unreferenced views anyway. */
const chunks = [bin];
let offset = bin.length;

for (const { imageIndex, png } of replacements) {
  const padding = (4 - (offset % 4)) % 4;
  if (padding) { chunks.push(Buffer.alloc(padding, 0)); offset += padding; }

  json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: png.length });
  chunks.push(png);
  offset += png.length;

  json.images[imageIndex].bufferView = json.bufferViews.length - 1;
  json.images[imageIndex].mimeType = 'image/png';
}

const bin2 = Buffer.concat(chunks);
json.buffers[0].byteLength = bin2.length;

writeGLB(OUT, json, bin2);
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`  -> ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB, pre-optimise)`);
