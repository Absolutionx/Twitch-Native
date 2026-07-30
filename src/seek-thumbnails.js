// VOD seek-bar hover previews from Twitch's storyboard sprite sheets (URL via
// chapters.js's GQL fetch). The metadata JSON is an array of quality tiers,
// each { quality, count, interval, width, height, rows, cols, images[] }
// covering the whole VOD. Note: count is total frames; rows/cols is the grid
// per image, so frames spill across `images` in order, and image entries are
// bare filenames resolved against the JSON's CDN directory.

import { invoke } from "@tauri-apps/api/core";

/** First present, non-null value among a few possible key spellings. */
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/** One quality tier's parsed layout, spanning the VOD's full duration
 * (count * intervalSec seconds), frames spread across one or more sprite
 * images in order. */
class StoryboardTier {
  constructor({ imageUrls, width, height, rows, cols, intervalSec, count }) {
    this.imageUrls = imageUrls;
    this.width = width;
    this.height = height;
    this.rows = rows;
    this.cols = cols;
    this.intervalSec = intervalSec;
    this.count = count;
    this.framesPerImage = rows * cols;
    this.durationSec = count * intervalSec;
  }

  /** Returns {url, width, height, backgroundX, backgroundY} for the frame
   * covering `sec`, or null if this tier has no images or sec is beyond
   * the last frame this tier actually covers. */
  frameFor(sec) {
    if (this.imageUrls.length === 0 || sec < 0) return null;
    const frameIndex = Math.min(this.count - 1, Math.floor(sec / this.intervalSec));
    const imageIndex = Math.floor(frameIndex / this.framesPerImage);
    const url = this.imageUrls[imageIndex];
    if (!url) return null;
    const indexWithinImage = frameIndex % this.framesPerImage;
    const row = Math.floor(indexWithinImage / this.cols);
    const col = indexWithinImage % this.cols;
    return {
      url,
      width: this.width,
      height: this.height,
      backgroundX: -(col * this.width),
      backgroundY: -(row * this.height),
    };
  }
}

/** Parses one tier entry, resolving its relative image filenames against
 * baseUrl (the storyboard metadata JSON's own URL - images live in the
 * same CDN directory). Returns null if required fields are missing. */
function parseTier(entry, baseUrl) {
  const width = Number(pick(entry, "width", "frame_width", "frameWidth"));
  const height = Number(pick(entry, "height", "frame_height", "frameHeight"));
  const rows = Number(pick(entry, "rows", "row_count", "rowCount"));
  const cols = Number(pick(entry, "cols", "columns", "col_count", "colCount"));
  const intervalSec = Number(pick(entry, "interval", "seconds_per_frame", "secondsPerFrame"));
  const count = Number(pick(entry, "count", "total_count", "totalCount"));
  const images = pick(entry, "images", "urls", "files");

  if (!width || !height || !rows || !cols || !intervalSec || !count || !Array.isArray(images)) {
    return null;
  }

  const imageUrls = images.map((filename) => new URL(filename, baseUrl).href);
  return new StoryboardTier({ imageUrls, width, height, rows, cols, intervalSec, count });
}

/** Parses the full storyboard JSON into a list of tiers (one per quality
 * level), preferring higher quality first when multiple exist - see
 * loadVodStoryboard's frameFor(), which tries each in order. */
function parseStoryboardJson(json, baseUrl) {
  const entries = Array.isArray(json) ? json : [json];
  const tiers = entries.map((e) => parseTier(e, baseUrl)).filter(Boolean);
  // Larger frame area (usually the "high" quality tier) first, so the
  // nicer thumbnail is preferred whenever more than one tier parsed
  // correctly.
  tiers.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  return tiers;
}

/**
 * Fetches and parses a VOD's storyboard. Returns an object with a single
 * method, frameFor(sec), returning frame info for the seek-bar tooltip to
 * render - or null if seconds is out of range or no storyboard exists.
 * Never throws: failures (network, missing storyboard, unrecognized
 * JSON shape) all resolve to a storyboard whose frameFor() always
 * returns null, so a hover preview just doesn't show rather than
 * breaking the tooltip.
 */
export async function loadVodStoryboard(seekPreviewsUrl) {
  const empty = { frameFor: () => null };
  if (!seekPreviewsUrl) return empty;

  try {
    // Plain fetch() here gets blocked by CORS - Twitch's storage CDN
    // (cloudfront.net) doesn't send an Access-Control-Allow-Origin header
    // permitting this app's webview origin to read the response
    // (confirmed via a real browser console error). reqwest on the Rust
    // side has no concept of CORS at all, so this sidesteps it the same
    // way fetch_link_preview does for link previews.
    const text = await invoke("fetch_storyboard_json", { url: seekPreviewsUrl });
    const json = JSON.parse(text);
    console.log("[seek-thumbnails] raw storyboard JSON:", JSON.stringify(json));

    const tiers = parseStoryboardJson(json, seekPreviewsUrl);
    if (tiers.length === 0) {
      console.warn("[seek-thumbnails] couldn't parse any tiers from storyboard JSON - see raw JSON logged above to adjust field-name handling in seek-thumbnails.js");
      return empty;
    }

    return {
      frameFor(sec) {
        for (const tier of tiers) {
          const frame = tier.frameFor(sec);
          if (frame) return frame;
        }
        return null;
      },
    };
  } catch (err) {
    console.warn("[seek-thumbnails] failed to load storyboard:", err);
    return empty;
  }
}
