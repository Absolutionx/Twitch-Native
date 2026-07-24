// Small display-formatting helpers shared across the UI modules.

/** Abbreviates a viewer count the way the card renderers do (1.2K, 48K).
 * home.js/browse.js/sidebar.js each still keep their own private copy;
 * this is the shared one for everything outside those three. */
export function formatViewerCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}
