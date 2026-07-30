// App chrome: page switching, theater mode, header/chat collapse, and OS
// fullscreen - each toggles a class on #app and syncs a button's active state.
// Page objects are injected (not imported) to avoid a cycle with main.js.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { session } from "./session.js";
import { resyncChannelInfoBarVisibility } from "./channel-info-bar.js";

const appWindow = getCurrentWindow();

const appEl = document.getElementById("app");
const theaterBtn = document.getElementById("theater-btn");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const headerCollapseToggle = document.getElementById("header-collapse-toggle");
const homeTab = document.getElementById("home-tab");
const browseTab = document.getElementById("browse-tab");
const backToStreamBtn = document.getElementById("back-to-stream-btn");
const backToStreamLabel = document.getElementById("back-to-stream-label");

// --- Injected collaborators (see initLayout) ----------------------------
let homeFeed, browsePage, vodsPage;

/** The channel currently playing, for the back-to-stream pill's label.
 * Injected as a getter rather than importing playbackControls: main.js
 * constructs that with callbacks that reach back into layout, so an
 * import here would be a cycle. */
let getCurrentChannel = () => "";

/** Hands layout the page objects and the current-channel getter that
 * main.js owns. Must run before any nav tab can be clicked. */
export function initLayout(deps) {
  homeFeed = deps.homeFeed;
  browsePage = deps.browsePage;
  vodsPage = deps.vodsPage;
  getCurrentChannel = deps.getCurrentChannel;
}

/** True OS fullscreen (no title bar) - distinct from theater mode, which
 * only collapses the app's own sidebar/header. */
let isFullscreen = false;

/** Read-only view of the OS-fullscreen flag, for callers that need to ask
 * "are we fullscreen?" without owning the state (main.js's Escape
 * handler). */
export function isAppFullscreen() {
  return isFullscreen;
}

/** Only theater mode may auto-restore a header IT auto-collapsed. If the
 * user had already collapsed it by hand, exiting theater mode must leave
 * it collapsed rather than undo a choice made independently of it. */
let _headerAutoCollapsedByTheater = false;

/** Switches between the Home feed and Browse page, keeping the nav tabs'
 * active-state styling, session.lastActivePage, and the back-to-stream button in
 * sync with whichever is now showing. Shared by both tab buttons' click
 * handlers below so Home<->Browse is symmetric in both directions, rather
 * than Browse only ever being something you enter and never click back out
 * of via the tabs themselves. */
export function switchPage(page) {
  if (page === session.lastActivePage && session.pageVisible) return;
  if (page === "browse") {
    homeFeed.hide();
    vodsPage.hide();
    browsePage.show();
  } else if (page === "vods") {
    homeFeed.hide();
    browsePage.hide();
    // vodsPage.show() is called by the Videos button handler with the
    // channel name - switchPage("vods") itself just manages visibility
    // state; the actual fetch/render is driven by the button handler.
    vodsPage.show(session.vodsChannel, { kick: session.vodsChannelIsKick });
  } else {
    browsePage.hide();
    vodsPage.hide();
    homeFeed.show();
  }
  session.lastActivePage = page;
  session.pageVisible = true;
  homeTab.classList.toggle("nav-tab-active", page === "home");
  browseTab.classList.toggle("nav-tab-active", page === "browse");
  // Theater mode collapses the channels sidebar to give the video extra
  // width (see setTheaterMode below) - that tradeoff only makes sense
  // while the video is actually what's on screen. Once Home/Browse is
  // covering it instead, the collapsed sidebar just permanently cuts off
  // the channel list for no benefit, since there's no video to make room
  // for anymore. Only relevant if a stream is actually playing - if
  // nothing's playing, theater mode was never turned on in the first place.
  if (session.playing) setTheaterMode(false);
  updateBackToStreamBtn();
  resyncChannelInfoBarVisibility();
}


/** Shows/hides the "Now watching: <channel>" pill based on current state:
 * visible only when a stream is actually playing AND Home/Browse is
 * currently covering it (no point showing a "go back to the video" button
 * when the video is already what's on screen). session.pageVisible=true means
 * Home/Browse is what's showing, so the pill condition is session.playing AND
 * session.pageVisible - NOT !session.pageVisible, which would mean "show the pill exactly
 * when the video itself is already visible," the opposite of the point. */
export function updateBackToStreamBtn() {
  const shouldShow = session.playing && session.pageVisible;
  backToStreamBtn.style.display = shouldShow ? "flex" : "none";
  if (shouldShow) {
    backToStreamLabel.textContent = `Now watching: ${getCurrentChannel() || ""}`;
  }
}


// --- Channel info bar ----------------------------------------------------
//
// Fills the space left over below #video-frame when not in theater mode -
// see the HTML comment on #channel-info-bar in index.html for the full
// rationale (mirrors the official site's below-player strip instead of
// leaving that area solid black).
//
/**
 * Toggles the sidebar-collapsing theater mode (see #app.theater-mode in
 * index.html) and keeps the controls-bar button's active styling in sync
 * with it. Centralized here so the automatic on-watch/on-stop behavior in
 * watchChannel()/stopBtn below and the manual button click both go through
 * one code path instead of drifting out of sync with each other.
 */
export function setTheaterMode(on) {
  appEl.classList.toggle("theater-mode", on);
  theaterBtn.classList.toggle("theater-active", on);

  // Auto-hide the top bar along with the sidebar when entering theater
  // mode, and auto-restore it on exit - but ONLY if theater mode is what
  // collapsed it in the first place. If the user had already manually
  // collapsed the header (via the toggle button) before theater mode was
  // ever turned on, exiting theater mode should leave it collapsed -
  // popping it back open would override a choice the user made
  // independently of theater mode and didn't ask to have undone.
  // _headerAutoCollapsedByTheater is the one piece of state that
  // distinguishes "collapsed because theater mode did it" from
  // "collapsed because the user clicked the button" - set here, and
  // cleared the moment the user manually toggles the header themselves
  // (see toggleHeaderCollapse below), so a manual action always wins
  // over whatever theater mode would otherwise do next.
  if (on) {
    if (!appEl.classList.contains("header-collapsed")) {
      appEl.classList.add("header-collapsed");
      headerCollapseToggle.title = "Expand top bar";
      _headerAutoCollapsedByTheater = true;
    }
  } else if (_headerAutoCollapsedByTheater) {
    appEl.classList.remove("header-collapsed");
    headerCollapseToggle.title = "Collapse top bar";
    _headerAutoCollapsedByTheater = false;
  }
}


/**
 * Flips theater mode. Shared by the button click, the T shortcut, and
 * (for the off-only direction) Escape below.
 */
export function toggleTheaterModeAndResync() {
  setTheaterMode(!appEl.classList.contains("theater-mode"));
}


/**
 * Collapses/expands the top bar (#app.header-collapsed - see index.html),
 * matching the same on-demand collapse Twitch's own chat panel offers,
 * just applied to the header row instead of the chat column. Independent
 * of theater mode/chat-collapse - all three are separate grid dimensions
 * (see the --header-height/--sidebar-width/--chat-width custom properties
 * in index.html) and combine freely.
 */
export function toggleHeaderCollapse() {
  const collapsed = !appEl.classList.contains("header-collapsed");
  appEl.classList.toggle("header-collapsed", collapsed);
  headerCollapseToggle.title = collapsed ? "Expand top bar" : "Collapse top bar";
  // This is now a deliberate, manual choice by the user (clicking the
  // button directly) - it always overrides whatever theater mode was
  // tracking, regardless of which direction either is currently set to.
  // Concretely: if the user manually collapses it themselves (even while
  // already in theater mode), that's no longer "theater mode's doing,"
  // so exiting theater mode later should leave it collapsed, not pop it
  // open - same logic in reverse if they manually re-expand it.
  _headerAutoCollapsedByTheater = false;
}


/**
 * Collapses/expands the chat column (#app.chat-collapsed), matching
 * Twitch's own "Collapse" affordance in the chat panel header. Two
 * separate click targets toggle the same state: chatCollapseToggle (the
 * "Collapse" button/label, visible while expanded) and chatExpandStrip
 * (the thin always-visible rail shown once collapsed) - see their
 * show/hide rules in index.html.
 */
export function toggleChatCollapse() {
  const collapsed = !appEl.classList.contains("chat-collapsed");
  appEl.classList.toggle("chat-collapsed", collapsed);
}


/**
 * Toggles true OS-level fullscreen for the whole Tauri window (no title
 * bar/taskbar), via the Window API - distinct from theater mode, which
 * only collapses the sidebar within the normal window. Tracked with a
 * local boolean rather than re-querying appWindow.isFullscreen()
 * afterward, since that query is documented as unreliable immediately
 * after a transition on some platforms; the local flag is set from the
 * same value this function itself just requested, so it can't drift out
 * of sync with what was actually asked for.
 *
 * #video-element just resizes via normal CSS along with everything else
 * here - no manual resync step needed for any of these toggles anymore
 * (theater mode/chat-collapse/header-collapse included), since there's no
 * second native surface whose position has to be recomputed and pushed
 * over IPC after a layout change.
 */
export async function toggleFullscreen() {
  isFullscreen = !isFullscreen;
  try {
    await appWindow.setFullscreen(isFullscreen);
  } catch (err) {
    console.error("Failed to toggle fullscreen:", err);
    isFullscreen = !isFullscreen; // revert the local flag - the call didn't take effect
    return;
  }
  appEl.classList.toggle("app-fullscreen", isFullscreen);
  fullscreenBtn.classList.toggle("is-fullscreen", isFullscreen);
  fullscreenBtn.title = isFullscreen ? "Exit Fullscreen" : "Fullscreen";
}

// Keeps isFullscreen/the fullscreen button's icon honest against
// fullscreen changes that didn't go through toggleFullscreen() itself -
// e.g. a native OS-level fullscreen shortcut, or any other path that
// changes the window's fullscreen state without this app's own button
// or Escape handler being involved. onResized is confirmed (per Tauri's
// own issue tracker) to fire for fullscreen transitions, not just plain
// resizing, so it's a reliable place to re-check rather than trusting
// the local flag could never drift.
appWindow.onResized(async () => {
  try {
    const actual = await appWindow.isFullscreen();
    if (actual !== isFullscreen) {
      isFullscreen = actual;
      appEl.classList.toggle("app-fullscreen", isFullscreen);
      fullscreenBtn.classList.toggle("is-fullscreen", isFullscreen);
      fullscreenBtn.title = isFullscreen ? "Exit Fullscreen" : "Fullscreen";
    }
  } catch (err) {
    console.error("Failed to check fullscreen state:", err);
  }
});
