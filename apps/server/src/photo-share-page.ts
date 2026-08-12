import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The wordmark is inlined as raw SVG markup (rather than referenced by URL)
// because this page is served from R2's own origin, not ours — a path like
// /assets/Wordmark.svg would 404 there. Read once and cache; the file
// doesn't change at runtime.
const here = path.dirname(fileURLToPath(import.meta.url));
const wordmarkPath = path.resolve(here, "../../web/public/assets/Wordmark.svg");
let cachedWordmark: string | null = null;

function wordmarkSvg(): string {
  if (cachedWordmark !== null) return cachedWordmark;
  try {
    cachedWordmark = readFileSync(wordmarkPath, "utf-8");
  } catch {
    cachedWordmark = "";
  }
  return cachedWordmark;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

// Matches .result-card-wrapper in styles.css: the captured JPEG is a DOM
// screenshot of the live result card's back face (see captureResultCard in
// App.tsx), taken at this exact aspect ratio — so the photo already has the
// Soma name, title, and Required Tasks baked into its pixels in the kiosk's
// own fonts/positions. This page's only job is to re-present that same
// image in a same-shaped rounded frame, not to redraw any of that text.
const CARD_ASPECT_RATIO = "5364 / 8874";
// The captured image itself uses the exact same radius as the live result
// card. Its parent remains a radius-free layout box, avoiding a second mask.
const CARD_BORDER_RADIUS = "8% / 5%";

/** The page a visitor lands on after scanning the QR code — a standalone,
 *  self-contained HTML document (own inline styles, wordmark inlined as
 *  SVG) since it's uploaded to and served from R2 directly, not our own
 *  server. */
export function renderPhotoSharePage(options: { imageUrl: string }): string {
  const { imageUrl } = options;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Eidos 사진</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.75rem;
    padding: 6vh 6vw;
    overflow-y: auto;
    background: radial-gradient(120% 90% at 50% -10%, #0a2540 0%, #030812 60%, #000 100%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Pretendard, sans-serif;
  }
  .card {
    /* Sized by whichever is tightest — viewport width, a sane max, or the
       height actually left over after the wordmark and padding — so the
       box is never squeezed by flex to fit and never has to distort off
       its true aspect ratio. flex-shrink: 0 is the second half of that
       guarantee: without it, a flex column will still shrink this item's
       height on a short viewport even though a width is set, breaking the
       ratio, visibly warping the corners). */
    width: min(88vw, 24rem, calc((100dvh - 12rem) * 5364 / 8874));
    aspect-ratio: ${CARD_ASPECT_RATIO};
    flex-shrink: 0;
    border-radius: 0;
    overflow: visible;
    background: transparent;
  }
  .card img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: ${CARD_BORDER_RADIUS};
    box-shadow: 0 1.5rem 4rem rgba(0, 8, 16, .5);
  }
  .wordmark { width: min(34vw, 6.8rem); height: auto; opacity: .92; }
  .wordmark svg { display: block; width: 100%; height: auto; }
</style>
</head>
<body>
  <div class="card"><img src="${escapeHtml(imageUrl)}" alt="촬영된 Eidos 사진" /></div>
  <div class="wordmark">${wordmarkSvg()}</div>
</body>
</html>
`;
}
