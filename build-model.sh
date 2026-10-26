#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# build-model.sh — master .glb -> served model variants
#
#   bash build-model.sh [path/to/master.glb]
#
# Defaults to the committed master in assets/reference/. Writes both variants
# into assets/model/, which js/viewer.js reads via modelSrc() in js/config.js.
#
# Why this exists, and why it is NOT the same shape as build-assets.sh:
#
#   The supplied master is 11.28 MB, but only ~13.7k triangles across 3 meshes.
#   Essentially all of that weight is texture: six uncompressed PNG/JPEG maps,
#   three of them over 2 MB each. So the win here is entirely in the textures,
#   not the geometry.
#
#   Consequences, both deliberate:
#
#   --compress false   Skips Draco. Draco compresses *geometry*, and 13.7k tris
#                      is already nothing — it would save a couple of hundred
#                      KB while forcing us to vendor and load a WASM decoder on
#                      the critical path of the viewer. Bad trade.
#
#   --simplify false   The `optimize` preset runs mesh simplification by
#                      DEFAULT, and it is not subtle: it took this model from
#                      13,694 tris to 9,967 (-27%) on the first pass. A
#                      keyboard is nothing but crisp bevels and tight keycap
#                      edges, which is exactly what a decimator eats first, and
#                      the geometry costs us nothing to keep. Leave it off.
#
#   Textures go to WebP because that is already this project's texture format
#   everywhere else. KTX2/Basis would beat it on *GPU* memory rather than
#   download size, but needs a vendored transcoder — not worth it at this poly
#   count.
#
#   Result: 11.28 MB -> ~905 KB desktop / ~687 KB mobile, full-detail geometry.
# ---------------------------------------------------------------------------
set -euo pipefail

MASTER="${1:-assets/reference/keyboard-master.glb}"
OUT="assets/model"
RECOLORED="assets/reference/keyboard-carta.glb"

if [ ! -f "$MASTER" ]; then
  echo "error: master not found: $MASTER" >&2
  exit 1
fi

mkdir -p "$OUT"

# Step 0: repaint the source model into the site palette. The supplied model is
# green and white; the rest of the page is beige PBT on off-white aluminium.
# See recolor-model.mjs for why this is done to the textures rather than to the
# material colours. Reads the palette out of css/base.css, so it tracks the
# site's tokens automatically.
echo "==> recolour to CARTA palette"
node recolor-model.mjs "$MASTER" "$RECOLORED"
MASTER="$RECOLORED"

# Shared flags. See the header for why compress/simplify are both off.
FLAGS="--texture-compress webp --compress false --simplify false"

echo "==> desktop (textures @2048)"
npx --yes @gltf-transform/cli@latest optimize \
  "$MASTER" "$OUT/carta60.glb" --texture-size 2048 $FLAGS

echo "==> mobile (textures @1024)"
npx --yes @gltf-transform/cli@latest optimize \
  "$MASTER" "$OUT/carta60@1024.glb" --texture-size 1024 $FLAGS

echo
echo "==> done"
ls -lh "$OUT"/*.glb | awk '{ print "   " $9 "  " $5 }'
echo
echo "Note: assets/model/poster.webp is the no-WebGL fallback still and is NOT"
echo "generated here — regenerate it by hand if the model changes."
