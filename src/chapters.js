// chapters.js — fetches Twitch VOD chapter markers directly from the GQL
// endpoint via browser fetch (gql.twitch.tv is in the Tauri CSP connect-src,
// so no Rust IPC hop is needed). Chapter data is public; no auth token needed.

const GQL_URL    = "https://gql.twitch.tv/gql";
// This is the public Client-ID the twitch.tv website itself uses for its
// GQL client — not a secret. It's the same well-known ID used by
// streamlink, yt-dlp, and many other open-source Twitch tools to query
// public GQL data without needing a registered app or user token.
const CLIENT_ID  = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL_QUERY  =
  "query GetVideoChapters($videoID: ID!) {" +
  "  video(id: $videoID) {" +
  "    moments(momentRequestType: VIDEO_CHAPTER_MARKERS) {" +
  "      edges { node { positionMilliseconds description } }" +
  "    }" +
  "  }" +
  "}";

/**
 * Fetch chapter markers for a Twitch VOD.
 * Returns an array of { positionSec, title } objects (empty if none).
 *
 * @param {string} videoId   - numeric Twitch VOD ID
 * @param {string} [token]   - optional OAuth access token (improves reliability)
 */
export async function fetchVodChapters(videoId, token = null) {
  const headers = {
    "Client-ID":    CLIENT_ID,
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `OAuth ${token}`;

  const resp = await fetch(GQL_URL, {
    method:  "POST",
    headers,
    body: JSON.stringify([{
      query:     GQL_QUERY,
      variables: { videoID: videoId },
    }]),
  });

  if (!resp.ok) {
    throw new Error(`GQL chapters ${resp.status}: ${await resp.text()}`);
  }

  const json = await resp.json();
  console.log("[chapters] raw GQL response for", videoId, ":", JSON.stringify(json));

  const data    = json[0]?.data;
  const moments = data?.video?.moments;

  // MomentConnection uses Relay-style edges/node pagination.
  const edges   = moments?.edges ?? [];
  const nodes   = edges.map(e => e.node).filter(Boolean);

  // Defensive fallback: some schema versions return a flat nodes array.
  const raw     = nodes.length ? nodes : (moments?.nodes ?? []);

  return raw.map(n => ({
    positionSec: (n.positionMilliseconds ?? 0) / 1000,
    title:       n.description
              || n.details?.game?.displayName
              || "Unknown",
  }));
}

const SEEK_PREVIEWS_QUERY =
  "query GetVideoSeekPreviews($videoID: ID!) {" +
  "  video(id: $videoID) {" +
  "    seekPreviewsURL" +
  "  }" +
  "}";

/**
 * Fetches the storyboard (seek-preview thumbnail) URL for a Twitch VOD.
 * This is NOT an image itself - it's a URL to a small JSON file
 * describing the sprite-sheet layout (which image(s), grid size, time
 * interval per frame). VOD-only: Twitch doesn't generate these for live
 * streams. Returns null if the VOD has no storyboard (rare, but some
 * VODs - e.g. very short ones - don't have one).
 *
 * @param {string} videoId
 * @param {string} [token] - optional OAuth access token (improves reliability)
 */
export async function fetchVodSeekPreviewsUrl(videoId, token = null) {
  const headers = {
    "Client-ID":    CLIENT_ID,
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `OAuth ${token}`;

  const resp = await fetch(GQL_URL, {
    method:  "POST",
    headers,
    body: JSON.stringify([{
      query:     SEEK_PREVIEWS_QUERY,
      variables: { videoID: videoId },
    }]),
  });

  if (!resp.ok) {
    throw new Error(`GQL seek-previews ${resp.status}: ${await resp.text()}`);
  }

  const json = await resp.json();
  return json[0]?.data?.video?.seekPreviewsURL ?? null;
}

