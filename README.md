# AV1 edge green-line repro

Minimal, self-contained reproduction of a Chromium rendering defect: **Chromium paints a bright
green band along the top edge of an AV1 video whose frame height is not a multiple of 8**, while
the same stream is clean in Firefox, mpv, and in Chromium's own software decoder.

First seen on Bilibili: an AV1 track with `coded size = visible rect = 1920x886` produced a green
line at the top of the picture in Chrome/Edge, while HEVC played fine and Firefox/mpv were clean.

Everything here is generated locally. No third-party media, no site dependency.

## Measured result

Chrome 157.0.8103.79 headless, AMD Radeon 780M (VCN AV1 decode), Windows, `D3D11VideoDecoder`, NV12,
BT.709 limited, 8-bit 4:2:0. Every clip is 1920 wide, flat gray, encoded with libaom.

| clip | H % 8 | hardware decode | software decode |
| --- | --- | --- | --- |
| 1920x886 | 6 | green rows 0–4, peak 223 | clean, peak 1 |
| 1920x888 | 0 | clean | clean |
| 1920x890 | 2 | green rows 0–11 | clean |
| 1920x884 | 4 | green rows 0–7 | clean |
| 1920x1080 | 0 | clean | clean |
| 1920x1088 | 0 | clean | clean |
| 1920x720 | 0 | clean | clean |

Consequences:

- The trigger is the **frame height**, not the site, the container, or the content.
- `h % 8 == 0` passes, `h % 8 != 0` fails, so the granularity is the 8-row padding, not 16.
- It reproduces **only on the hardware path**. `--disable-accelerated-video-decode` makes every
  clip clean, so the defect is in the D3D11 AV1 decode/copy path, not in the AV1 bitstream or in
  Chromium's software (dav1d) decoder.

## Mechanism

The number of affected rows follows `2 * (8 - h % 8)` exactly:

| height | padding to 8 | green rows |
| --- | --- | --- |
| 886 | 2 | 4 (+1 blended) |
| 884 | 4 | 8 (+1 blended) |
| 890 | 6 | 12 (+1 blended) |

The pixels explain the factor of two. Inside the band the sampled RGB is `(0, 222, 0)`, and
`Y = 126, U = V = 0` under BT.709 limited range converts to exactly `(0, 223, 0)`: **luma is
correct, chroma is zero**. Where the band crosses the clip's dark inner border the pixel becomes
`(0, 158, 0)`, i.e. the same zeroed chroma over a darker luma — the picture itself is fine.

Since NV12 chroma is subsampled 2:1 vertically, a chroma offset of `k` rows affects `2k` luma
rows. The observed `2 * (8 - h % 8)` luma rows therefore correspond to a chroma plane offset of
`(8 - h % 8)` rows — that is, **the luma padding row count is applied to the chroma plane without
halving it**. That is the shape of the bug to look for in the D3D11 AV1 frame copy / video
processor setup.

Zeroed NV12 must never reach the screen as green: a correct implementation clamps or crops to the
visible rect.

## Quick start

```powershell
# 1. generate the clips (needs ffmpeg with libaom-av1)
powershell -ExecutionPolicy Bypass -File tools/make-clips.ps1

# 2. serve the page (file:// taints the canvas, which kills pixel checks)
node serve.js
#    -> http://127.0.0.1:8777/
```

Then click **Scan all clips**. For each clip the page plays it, reads the decoded frame through a
canvas, and reports which of the top/bottom 24 rows contain "green" pixels plus the peak
`g - max(r, b)` value. A neutral gray picture sits at 0; a zeroed-chroma row jumps to ~220.

Why the page needs HTTP: a `file://` page has an opaque origin, so drawing the video into a canvas
taints it and `getImageData` throws.

## Screenshots

```powershell
node serve.js            # in one terminal
node tools/shot.js       # -> out/clip-h<height>.png, ~1.5 s for all seven
```

`tools/shot.js` drives headless Chrome over the DevTools protocol and does one thing: for each
clip it asks the page to start playback, waits for the page to report that the first frame is
actually on screen, calls `Page.captureScreenshot` (the API DevTools itself uses), then asks for
the next clip. No manual screenshots, no fixed sleeps.

For a bug report you only need two of them: `clip-h886.png` (green band) and `clip-h1088.png`
(control).

## Test matrix

| height | alignment | purpose |
| --- | --- | --- |
| 1088 | 16 / 64 | baseline, expected clean |
| 1080 | 8, not 16 | shows the threshold is 8, not 16 |
| 888 | 8 | baseline |
| 884 | 4 | probes 4-row alignment |
| **886** | 2 (`2 x 443`) | the observed case |
| 890 | 2 | second 2-aligned sample |
| 720 | — | small control |

All clips share encoder settings, picture, duration (3 s) and frame rate (30 fps); only the height
differs, so the height is the single independent variable.

**The encoder must be libaom, not SVT-AV1.** SVT silently rounds the height up to a multiple of 8
(886 becomes 888, 890 becomes 896), which erases the exact variable under test. `make-clips.ps1`
probes every output and fails loudly on a mismatch.

## How to read the results

1. **Control group.** 1088 and 720 clean while 886 is not: the trigger is the height.
2. **Modulus.** Clean at `h % 8 == 0`, green otherwise: 8-row granularity.
3. **Hardware vs software.** Green with hardware decode, clean with `--disable-accelerated-video-decode`.
4. **Scaling.** Clean at 1:1 but green at 0.75x would point at the video processor sampling outside
   the source rect instead of at the frame copy.

The "Eyeball" column exists because the canvas only sees decoded frames. A clean canvas with a
visible green line means the defect is downstream (compositor or overlay) — still a valid finding.

## Notes

- The artifact is pixel-exact and does not need a visible window: it also reproduces in headless
  Chrome and shows up in `Page.captureScreenshot`, so it is a compositor-level defect, not a
  display-sync or cable artifact.
- Software decode on the same machine is always clean, and so is the HEVC path (Media Foundation)
  on the same stream, which is why switching the site to HEVC works around it.
- Video heights that are not a multiple of 8 are legal AV1 and legal in MP4; 886 appears in the
  wild on Bilibili's AV1 transcodes.

## Files

```
index.html, style.css, app.js   test page: plays clips, reports when a frame is on screen
serve.js                        zero-dependency static server with Range support
tools/make-clips.ps1            generates clips/ with ffmpeg + libaom
tools/shot.js                   plays every clip and saves a screenshot of each (~1.5 s)
docs/issue-draft.md             ready-to-paste Chromium bug report with this data
```

`clips/` and `out/` are generated and therefore not committed.

## License

MIT
