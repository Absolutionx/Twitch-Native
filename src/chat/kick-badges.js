// Renders Kick chat badges ("kick/{type}/{count}" in the badges tag, see
// kick_badges_tag in kick_chat.rs). Kick has no per-badge endpoint, so these
// are inline-SVG recreations of the known set. Exception: subscriber badges are
// real uploaded images (subscriber_badges on the channel payload), months-
// matched with the generic star as fallback. Unknown types render nothing.

const KICK_GREEN = "#53fc18";

/** type -> {title, svg builder}. Builders take the badge's count so
 * tiered art (sub_gifter) and count-bearing titles can use it. */
const KICK_BADGES = {
  broadcaster: {
    title: () => "Broadcaster",
    svg: () =>
      `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="1" y="4" width="9.5" height="8" rx="2" fill="#ff4b4b"/>` +
      `<path fill="#ff4b4b" d="M11.4 6.9 15 4.6v6.8l-3.6-2.3z"/></svg>`,
  },
  moderator: {
    title: () => "Moderator",
    svg: () =>
      `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><g fill="${KICK_GREEN}">` +
      `<path d="M14.9 1.1h-3.2L4.9 7.9l3.2 3.2 6.8-6.8z"/>` +
      `<path d="M4.2 8.6 2.8 10l1.1 1.1-2.5 2.5 1 1 2.5-2.5L6 13.2l1.4-1.4z"/>` +
      `</g></svg>`,
  },
  vip: {
    title: () => "VIP",
    svg: () =>
      `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
      `<path fill="#ff3fa4" d="M3.2 2.5h9.6L15.4 6 8 14 .6 6z"/>` +
      `<path fill="#ffffff" opacity="0.35" d="M3.2 2.5 8 6l4.8-3.5z"/></svg>`,
  },
  og: {
    title: () => "OG",
    svg: () =>
      `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
      `<defs><linearGradient id="kb-og" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="#00fff2"/><stop offset="1" stop-color="#0075ff"/>` +
      `</linearGradient></defs>` +
      `<rect x="0.8" y="2.8" width="14.4" height="10.4" rx="2.4" fill="url(#kb-og)"/>` +
      `<text x="8" y="10.9" text-anchor="middle" font-family="Arial, sans-serif" ` +
      `font-size="7.4" font-weight="900" fill="#000">OG</text></svg>`,
  },
  founder: {
    title: () => "Founder",
    svg: () =>
      `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
      `<defs><linearGradient id="kb-founder" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="#ffd24a"/><stop offset="1" stop-color="#ff9d00"/>` +
      `</linearGradient></defs>` +
      `<path fill="url(#kb-founder)" d="M8 .8 14.3 4.4v7.2L8 15.2 1.7 11.6V4.4z"/>` +
      `<path fill="#000" opacity="0.85" d="M8 4.1l1.15 2.3 2.55.37-1.85 1.8.44 2.53L8 9.9l-2.29 1.2.44-2.53-1.85-1.8 2.55-.37z"/>` +
      `</svg>`,
  },
  verified: {
    title: () => "Verified",
    svg: () =>
      `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
      `<circle cx="8" cy="8" r="7" fill="${KICK_GREEN}"/>` +
      `<path d="M4.7 8.3l2.2 2.2 4.4-4.8" stroke="#000" stroke-width="1.9" fill="none" ` +
      `stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  },
  staff: {
    title: () => "Kick Staff",
    svg: () =>
      `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="1.2" y="1.2" width="13.6" height="13.6" rx="3" fill="${KICK_GREEN}"/>` +
      // Blocky Kick-logo "K".
      `<path fill="#000" d="M4.4 3.4h2.8v3.2h1.6V5h1.6V3.4h2.8v3.2h-1.6v1.6h1.6v3.2h-2.8V9.8H8.8V8.2H7.2v4.4H4.4z"/>` +
      `</svg>`,
  },
  sidekick: {
    title: () => "Sidekick",
    svg: () =>
      `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
      `<path fill="#ff9d00" d="M9.6.9 2.9 9h3.7L6 15.1 12.9 7H9z"/></svg>`,
  },
  bot: {
    title: () => "Bot",
    svg: () =>
      `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="1.5" y="4" width="13" height="9.5" rx="2" fill="#a6a6ab"/>` +
      `<rect x="7.3" y="1.5" width="1.4" height="3" fill="#a6a6ab"/>` +
      `<circle cx="5.4" cy="8.2" r="1.3" fill="#000"/><circle cx="10.6" cy="8.2" r="1.3" fill="#000"/>` +
      `<rect x="5" y="10.6" width="6" height="1.2" rx="0.6" fill="#000"/></svg>`,
  },
  subscriber: {
    title: (count) =>
      count > 1 ? `Subscriber (${count} months)` : "Subscriber",
    // Generic fallback star - only used when the channel has no custom
    // subscriber badge art (see kickBadgeElement below).
    svg: () =>
      `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
      `<path fill="${KICK_GREEN}" d="M8 .9l2.2 4.4 4.9.7-3.6 3.5.9 4.9L8 12.1l-4.4 2.3.9-4.9L.9 6l4.9-.7z"/>` +
      `</svg>`,
  },
  sub_gifter: {
    title: (count) => (count > 1 ? `Sub Gifter (${count})` : "Sub Gifter"),
    svg: (count) => {
      // Tiered gift colors, roughly tracking kick.com's escalation.
      const color =
        count >= 200 ? KICK_GREEN
        : count >= 100 ? "#ffc107"
        : count >= 50 ? "#ff5757"
        : count >= 25 ? "#a95df0"
        : "#35c2f1";
      return (
        `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
        `<g fill="${color}">` +
        `<rect x="2" y="7.2" width="12" height="7.6" rx="1.2"/>` +
        `<rect x="1.2" y="3.9" width="13.6" height="2.6" rx="0.9"/>` +
        `<path d="M7.9 3.6C6.9 1.6 4.2 1.8 4.2 3.2c0 .9 1 1.3 3.7 1.3zM8.1 3.6c1-2 3.7-1.8 3.7-.4 0 .9-1 1.3-3.7 1.3z"/>` +
        `</g><rect x="7.2" y="3.9" width="1.6" height="10.9" fill="#0009"/></svg>`
      );
    },
  },
};

/**
 * Builds the badge element for one kick/{type}/{count} entry, or null
 * for a type this module doesn't know (skip silently, matching how
 * renderBadges treats unresolvable Twitch pairs).
 *
 * @param {string} type
 * @param {number} count - the badge's own count (subscriber months,
 *   gifted-sub totals); 1 when the badge carries none.
 * @param {Array<{months:number, src:string}>} [subscriberBadges] - the
 *   channel's custom subscriber badge tiers (KickLiveInfo's
 *   subscriber_badges), consulted for type === "subscriber".
 * @returns {HTMLElement|null}
 */
export function kickBadgeElement(type, count, subscriberBadges) {
  // Channel-custom subscriber art: highest tier the sender's months
  // reach (a 9-month sub with {1,3,6,12} tiers wears the 6-month art) -
  // same months-matching kick.com's chat does.
  if (type === "subscriber" && Array.isArray(subscriberBadges)) {
    let best = null;
    for (const b of subscriberBadges) {
      if (!b || typeof b.months !== "number" || !b.src) continue;
      if (b.months <= count && (!best || b.months > best.months)) best = b;
    }
    if (best) {
      const img = document.createElement("img");
      img.className = "chat-badge";
      img.src = best.src;
      img.alt = "Subscriber";
      img.title = KICK_BADGES.subscriber.title(count);
      img.loading = "lazy";
      return img;
    }
    // No tier reached / no custom art -> generic star below.
  }

  const def = KICK_BADGES[type];
  if (!def) return null;
  const span = document.createElement("span");
  span.className = "chat-badge kick-badge";
  span.title = def.title(count);
  span.innerHTML = def.svg(count);
  return span;
}
