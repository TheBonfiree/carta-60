#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# build-assets.sh — derive every served asset from the masters in
# assets/reference/. Idempotent: safe to re-run after replacing a master.
#
#   bash build-assets.sh
#
# Requires ffmpeg on PATH. Nothing here runs at page load; the outputs are
# committed alongside the source.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"

REF=assets/reference
Q_FRAME=78     # webp quality for scrub frames — invisible loss at 1600px
Q_STILL=82
FEATHER=110    # px of alpha falloff at the image edge

# The renders sit on a soft neutral studio gradient, not a flat colour, so a
# hard rectangle would show its bounding box against the page. Feathering the
# outer edge to transparent lets every asset dissolve into the background at
# any page width. `bb=0.99` warms the neutral render field a touch toward the
# page's off-white.
FEATHER_VF="format=rgba,\
colorchannelmixer=bb=0.99,\
geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':\
a='255*min(1,min(min(X,W-1-X),min(Y,H-1-Y))/${FEATHER})'"

echo "==> assembly frames"
rm -f assets/assembly/frame_*.webp assets/assembly-mobile/frame_*.webp
mkdir -p assets/assembly assets/assembly-mobile

# -fps_mode passthrough: emit every real frame, no duplication and no drops.
# Duplicated frames read as stutter during a scrub; a shorter honest sequence
# does not. Whatever count lands here must match FRAMES.count in js/config.js.
# -c:v libwebp is NOT optional: given a multi-frame input and a .webp pattern,
# ffmpeg otherwise picks libwebp_anim and writes ONE animated file rather than
# a numbered sequence.
ffmpeg -y -v error -i "$REF/assembly-master.mp4" \
  -fps_mode passthrough -vf "scale=1600:-2,$FEATHER_VF" \
  -c:v libwebp -q:v $Q_FRAME "assets/assembly/f_%04d.webp"

# ffmpeg's image2 muxer starts at 1; the JS indexes from 0.
i=0
for f in $(ls assets/assembly/f_*.webp | sort); do
  mv "$f" "$(printf 'assets/assembly/frame_%04d.webp' $i)"
  i=$((i+1))
done
TOTAL=$i
echo "    $TOTAL frames"

# Mobile: every other frame at 1200px. Halves both the download and the
# decoded-bitmap memory a phone has to hold.
j=0
for ((n=0; n<TOTAL; n+=2)); do
  ffmpeg -y -v error -i "$(printf 'assets/assembly/frame_%04d.webp' $n)" \
    -vf scale=1200:-2 -q:v 76 "$(printf 'assets/assembly-mobile/frame_%04d.webp' $j)"
  j=$((j+1))
done
echo "    $j mobile frames"

echo "==> hero"
ffmpeg -y -v error -i "$REF/hero-still.png" -vf "scale=2400:-2,$FEATHER_VF" -q:v $Q_STILL assets/hero/hero.webp
ffmpeg -y -v error -i "$REF/hero-still.png" -vf "scale=1200:-2,$FEATHER_VF" -q:v $Q_STILL "assets/hero/hero@1200.webp"

# Social card: no feathering (it is composited on unknown backgrounds) and a
# hard 1200x630 crop.
ffmpeg -y -v error -i "$REF/exploded.png" \
  -vf "scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630" \
  -q:v $Q_STILL assets/hero/og-share.webp

echo "==> details"
ffmpeg -y -v error -i "$REF/detail-switch.png"  -vf "scale=1800:-2,$FEATHER_VF" -q:v 80 assets/detail/detail-01.webp
ffmpeg -y -v error -i "$REF/detail-topdown.png" -vf "scale=1800:-2,$FEATHER_VF" -q:v 80 assets/detail/detail-02.webp
ffmpeg -y -v error -i "$REF/detail-profile.png" -vf "scale=1800:-2,$FEATHER_VF" -q:v 80 assets/detail/detail-03.webp

echo
echo "Done. Set FRAMES.count = $TOTAL and FRAMES.mobileCount = $j in js/config.js"
du -sh assets/assembly assets/assembly-mobile assets/hero assets/detail
