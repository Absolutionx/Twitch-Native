// chat-vod-replay.js — the VOD chat replay engine, mixed into TwitchChat.
//
// Extracted verbatim from chat.js's setVodMode: everything about
// replaying a VOD's GQL comments in sync with playback lives here - the
// paging/dedupe/forward-search fetch loop, seek detection and the
// notifyVodSeek hook playback-controls.js calls, and the tick loop that
// flushes queued messages at their timestamps. It's a complete state
// machine of its own (every piece of its state is a closure local, none
// of it shared with live chat beyond the render pipeline), which is
// exactly why it moved out of chat.js rather than growing there - see
// each inline comment for the individual behaviors, all preserved
// as-was from the extraction.

import { invoke } from "@tauri-apps/api/core";
import { reconstructVodMessage } from "./emote-parsing.js";

export const chatVodReplayMixin = {
  /**
   * Disconnects any live chat connection and starts VOD chat replay for
   * `videoId`, synchronised to the video element's playback position via
   * `getPosition()` (a function the caller provides that returns the
   * current playback-time in seconds).
   *
   * The replay engine fetches a page of Kraken v5 chat comments ahead of
   * the current position, schedules each message to appear at its
   * content_offset_seconds, and pre-fetches the next page before the
   * current one runs out. Seeking resets the engine and re-fetches from
   * the new position automatically (it detects a position jump > 5s).
   */
  async setVodMode(videoId, getPosition, broadcastLogin = "", initialPositionSecs = 0) {
    return this._serializeLifecycle(() =>
      this._doSetVodMode(videoId, getPosition, broadcastLogin, initialPositionSecs),
    );
  },

  async _doSetVodMode(videoId, getPosition, broadcastLogin = "", initialPositionSecs = 0) {
    await this._doDisconnect();
    // Drop the previous live channel's channel-level emotes - connect()
    // fully clears the emote map on every live channel switch, but this
    // path only goes through disconnect(), which doesn't, so a VOD
    // opened after watching a live channel silently rendered that
    // channel's emotes in the (unrelated) VOD's chat. Globals stay (see
    // _clearChannelEmotes) and are re-fetched below anyway.
    this._clearChannelEmotes();
    this.container.innerHTML = "";
    this.channel = null;
    this.setStatus("replay");
    this.systemLine("Loading chat replay…");

    // VOD chat is read-only replay, not a live connection - hide the
    // input row entirely rather than leaving an enabled box that looks
    // like it should work. See _setInputRowVisible()'s comment.
    this._isVodMode = true;
    this._setInputRowVisible(false);

    // Stop any previous replay loop.
    if (this._vodReplayStop) this._vodReplayStop();

    let stopped = false;
    this._vodReplayStop = () => { stopped = true; };

    // Load global emotes (7TV, BTTV, Twitch's own) - connect() (live
    // chat) is the only other place these load, so without this, a VOD
    // opened without ever having connected to a live channel's chat
    // first in the same session would have NO global emotes at all,
    // not just missing 7TV ones - confirmed as a real gap while
    // investigating a specific 7TV global emote (LOLW) not rendering in
    // VOD replay. Fire-and-forget and idempotent (each just repopulates
    // the same Map), so calling these again is harmless even if an
    // earlier live connection in this session already loaded them.
    this.loadSevenTvGlobalEmotes();
    this.loadBttvGlobalEmotes();
    this.loadFfzGlobalEmotes();
    this.loadTwitchGlobalEmotes();

    // Load the broadcaster's 7TV channel emotes so they render in VOD
    // replay the same way they do in live chat. 7TV's /users/twitch/:id
    // endpoint needs the broadcaster's NUMERIC Twitch user id, not their
    // login name (confirmed via a real 404 - "user not found" - for a
    // channel that does have 7TV emotes configured, plus the actively-
    // maintained twitch-emoticons library's own docs stating the same
    // requirement) - broadcastLogin is only ever a login string here
    // (VOD mode has no IRC ROOMSTATE to source a numeric id from the way
    // live chat's own call to this same function does via this.roomId),
    // so it has to be resolved first via Helix. Fire-and-forget: this is
    // a nice-to-have emote set, not something VOD chat should ever wait
    // on or fail over - not being logged in (get_user_id_for_login needs
    // an auth token) just means no 7TV channel emotes for this session,
    // same as any other failure here.
    if (broadcastLogin) {
      console.log(`[7tv] Loading channel emotes for VOD replay, broadcastLogin="${broadcastLogin}"`);
      invoke("get_user_id_for_login", { login: broadcastLogin })
        .then((userId) => {
          console.log(`[7tv] Resolved "${broadcastLogin}" -> userId=${userId}, loading channel emotes`);
          this.loadSevenTvChannelEmotes(userId);
          // Same fix as the live chat-room handler: BTTV channel emotes
          // and FFZ emotes were never loaded for VOD replay either -
          // this is why LOLW/KEKW (FFZ channel emotes) also showed as
          // bare text in VOD chat, not just live.
          this.loadBttvChannelEmotes(userId);
          this.loadFfzChannelEmotes(userId);
        })
        .catch((err) => console.warn("Failed to resolve broadcaster id for 7TV channel emotes:", err));
    } else {
      // If this fires, broadcastLogin itself is the problem - the whole
      // channel-emote fetch below never even starts, completely
      // silently (no warning, nothing), which looks identical in the
      // console to the fetch actually running and simply not logging
      // anything - added specifically to tell those two cases apart
      // after a real report of a channel emote (LOLW) not rendering in
      // VOD replay with no diagnostic output at all in the console.
      console.warn("[7tv] Skipping VOD channel-emote load entirely - broadcastLogin is falsy:", broadcastLogin);
    }

    // Reload global badges and channel badges - disconnect() above clears
    // badgeMap, and no other path (setLoggedIn/connect) refills it for
    // VODs. Without this, the badge tags extracted from GQL comments would
    // never render because badgeMap is empty for the whole VOD session.
    this.loadGlobalBadges();
    if (broadcastLogin) {
      // Channel badges need the broadcaster's user ID, not their login
      // name. Look it up via the same Rust command the channel info bar
      // uses - fire-and-forget, badges backfill retroactively via
      // _backfillBadges() once the data arrives.
      invoke("get_user_by_login", { login: broadcastLogin })
        .then(raw => {
          const user = JSON.parse(raw);
          if (user?.id) this.loadChannelBadges(user.id);
        })
        .catch(() => {}); // missing channel badges are non-critical
    }

    const LOOKAHEAD_S = 30;   // fetch comments up to 30s ahead of position
    const CHECK_MS   = 500;   // how often to check for new messages to show
    const _t0 = performance.now();
    const _ts = () => ((performance.now() - _t0) / 1000).toFixed(2) + "s";

    // Queue of {offset, user, color, body, emotesTag} objects that have
    // been fetched but not yet displayed.
    let queue = [];
    let fetchCursor = "";
    let fetchedUpTo = -1;   // highest content_offset_seconds fetched so far
    // Every comment id (or composite fallback - see dedupeKey in
    // fetchPage) already pushed into the queue this session. Twitch's
    // offset-based query returns the page CONTAINING the requested
    // timestamp, not the page after it (confirmed via a real log: a
    // query at 27698.2 returned offsets 27687..27709), so any retry or
    // offset-based continuation is practically guaranteed to overlap
    // comments already fetched - without this, every stall recovery
    // re-queued and re-RENDERED up to a full page of already-shown
    // messages, and worse, overlap pages looked like "no progress"
    // (fetchedUpTo unchanged) to the old stall detector even when they
    // were a perfectly normal step toward the frontier. Cleared on every
    // resetAndFetch: after a backward seek the container is wiped and
    // messages SHOULD render again.
    let seenComments = new Set();
    // Forward-search distance for retries after a cursor chain
    // dead-ends. Twitch's cursor chains routinely report
    // hasNextPage:false well before the VOD actually ends (see
    // cursorExhausted below), and per the overlap behavior above,
    // re-querying AT the frontier just returns the page we already
    // have. So each retry that yields nothing new pushes the next
    // search offset further past the frontier (+5s per attempt, capped)
    // until a page with unseen comments turns up. The old version of
    // this (stuckOffsetNudge gated behind a separate two-strikes stuck
    // detector, with the retry cadence ALSO doubling on every attempt)
    // was the confirmed cause of VOD chat rhythmically stalling for the
    // full 1+2+4+8s... backoff staircase at every dead-end before
    // recovering, then repeating at the next one - on VODs whose chains
    // dead-end after nearly every page, that meant a visible hang every
    // few seconds of playback. Dedupe also removes the old mechanism's
    // documented cost: the overlap page is re-fetched and filtered, so
    // nudging forward no longer skips the small window of comments it
    // jumps over. Reset to 0 the moment any retry returns something new.
    let stuckOffsetNudge = 0;
    let lastPosition = -1;  // for jump detection (seeks)
    let fetching = false;
    // Incremented by resetAndFetch() whenever a seek resets position from
    // scratch. fetchPage() captures this value on entry and checks it
    // after the await returns - if it changed while the network request
    // was in flight (meaning a seek happened mid-fetch), the results are
    // stale and get discarded rather than pushed into the queue for the
    // wrong position. Without this, a seek that fires while tick() is
    // awaiting a fetchPage() call would have that old fetch's results
    // pushed into the queue immediately after the reset, clobbering the
    // fresh post-seek state with pre-seek comments.
    let fetchGeneration = 0;
    // Seek-detection stays disabled until getPosition() is actually
    // observed close to expectedPosition - confirming playback has truly
    // caught up to where we last told chat replay to be, rather than
    // guessing how long that takes. See tick()'s use of this for why a
    // fixed timeout can't work here: resuming deep into a VOD can leave
    // getPosition() reporting stale/zero for well over 10 seconds while
    // HLS.js loads the manifest and performs the actual seek (confirmed
    // via a real log: pos read 0.0 for a full 15 seconds after resuming
    // ~5 hours into a VOD) - a fixed grace period long enough to cover
    // that would be needlessly long for the common case of resuming near
    // the start, and any fixed value can still be wrong for some VOD.
    let awaitingPositionSync = true;
    let expectedPosition = initialPositionSecs;
    let _syncWaitStartedAt = performance.now();

    // True once a fetch has confirmed (via hasNextPage: false) that
    // Twitch's CURRENT cursor chain has no more comments. This does NOT
    // mean the rest of the VOD has no comments - confirmed via real
    // testing, Twitch's cursor-based pagination can report
    // hasNextPage:false well before the VOD actually ends (e.g. at the
    // ~15924s mark of a video with much more than that left to play),
    // and a fresh OFFSET-based fetch (empty cursor) from further along
    // the VOD successfully finds more comments past that point. Without
    // this distinction, the old code's pre-fetch trigger (gated on
    // `fetchCursor !== ""`) could never fire again once the cursor chain
    // ended, even with most of the VOD's runtime - and likely more chat
    // activity - still ahead. See the pre-fetch trigger below for how
    // this gets used to retry with a fresh offset instead of giving up.
    let cursorExhausted = false;
    // Adaptive backoff for exhausted-cursor retries. Starts at 1s and
    // doubles on each consecutive empty result (cap 30s), but resets to
    // 1s the moment a retry actually returns comments. This handles two
    // real cases seen in testing:
    //   - VOD whose cursor always immediately dead-ends (returns 0 on the
    //     very next call after every page): a fixed 10s throttle caused a
    //     10s blackout after every ~5s page, making chat feel very choppy.
    //     With 1s base delay, those gaps shrink to ~1s.
    //   - VOD that genuinely has no more comments (near the end): backoff
    //     doubles each empty retry (1→2→4→8→16→30s cap), so we stop
    //     hammering the API once we've confirmed there's really nothing left.
    let exhaustedRetryDelay = 1000;   // ms, current backoff interval
    let lastExhaustedRetryAt = -Infinity; // performance.now() timestamp
    // Tick counter purely for debug log spacing - logs every 4th tick
    // (~2s) to keep the console readable without missing anything.
    let _tickN = 0;

    console.log(`[vod-chat] ${_ts()} start video=${videoId}`);

    const resetAndFetch = async (fromSeconds) => {
      console.log(`[vod-chat] ${_ts()} RESET to ${fromSeconds.toFixed(1)}s  fetching=${fetching} gen=${fetchGeneration}->${fetchGeneration+1}  queue=${queue.length}  fetchedUpTo=${fetchedUpTo}`);
      queue = [];
      fetchCursor = "";
      fetchedUpTo = -1;
      // Fresh Set rather than .clear() so a still-in-flight fetch that's
      // about to be discarded as stale can't race writes into the new
      // position's dedupe state.
      seenComments = new Set();
      stuckOffsetNudge = 0;
      lastPosition = fromSeconds;
      cursorExhausted = false;
      exhaustedRetryDelay = 1000;
      lastExhaustedRetryAt = -Infinity;
      fetchGeneration++;
      // Position hasn't caught up to fromSeconds yet - don't trust
      // seek-detection again until it's confirmed to have (see
      // awaitingPositionSync's declaration for why a fixed timer can't
      // work here). Needed on EVERY reset, not just the initial one: a
      // real seek's own resetAndFetch sets the correct new position, but
      // without re-arming this the very next tick could still read the
      // STALE pre-seek position, misread it as a fresh seek back to
      // where it just was, then the tick after that would read the now-
      // correct position and misread THAT as yet another seek - three
      // resets cascading in barely a second, confirmed via a real seek
      // log.
      awaitingPositionSync = true;
      expectedPosition = fromSeconds;
      _syncWaitStartedAt = performance.now();
      this.container.innerHTML = "";
      this.systemLine("Chat replay restarting from new position…");
      await fetchPage(fromSeconds);
      // Anchor the exhausted-retry throttle to now so the first retry
      // after this reset waits a full 10s, not 0s.
      if (lastExhaustedRetryAt === -Infinity) lastExhaustedRetryAt = performance.now();
    };

    // Public hook for main.js: playbackControls.onSeek calls this directly
    // whenever a real VOD seek happens (seek-bar click, arrow-key seek, or
    // a chapter-list jump - see their onSeek() calls in playback-controls.js),
    // giving chat an explicit, unambiguous seek signal instead of having to
    // infer one purely from tick()'s own position polling below. That
    // inference alone is structurally ambiguous - too loose and a quiet
    // stretch of chat gets misread as a seek (the original bug); too tight
    // and a real-but-small seek like a single 5s arrow-key press goes
    // undetected (the regression after fixing that). tick()'s polling-based
    // detection is left in place as a backstop for anything that might
    // someday seek without going through one of those three call sites, but
    // for every seek path that exists today, this is what actually fires.
    this.notifyVodSeek = (newPositionSeconds) => {
      if (!this._isVodMode || stopped) return;
      console.log(`[vod-chat] ${_ts()} notifyVodSeek(${newPositionSeconds.toFixed(1)})  fetching=${fetching}`);
      resetAndFetch(newPositionSeconds);
    };

    const fetchPage = async (fromSeconds) => {
      if (fetching || stopped) {
        console.log(`[vod-chat] ${_ts()} fetchPage(${fromSeconds.toFixed(1)}) SKIPPED  fetching=${fetching} stopped=${stopped}`);
        return;
      }
      fetching = true;
      const myGeneration = fetchGeneration;
      const fetchStart = performance.now();
      // Captured to tell "cursor actually advanced" apart from Twitch
      // returning the same page with hasNext=true in a loop (a confirmed
      // real failure mode - see the no-way-forward branch below).
      const pageCursorBefore = fetchCursor;
      console.log(`[vod-chat] ${_ts()} fetchPage(${fromSeconds.toFixed(1)}) START  cursor=${fetchCursor ? "set" : "empty"}  gen=${myGeneration}`);
      try {
        const raw = await invoke("get_vod_chat", {
          videoId,
          offsetSeconds: fromSeconds,
          cursor: fetchCursor,
        });
        const elapsed = ((performance.now() - fetchStart) / 1000).toFixed(2);
        // If a seek (resetAndFetch) fired while this request was in
        // flight, fetchGeneration will have been incremented and our
        // results are now stale - discard them rather than pushing
        // pre-seek comments into the post-seek queue.
        if (stopped || fetchGeneration !== myGeneration) {
          console.log(`[vod-chat] ${_ts()} fetchPage(${fromSeconds.toFixed(1)}) STALE after ${elapsed}s  gen was ${myGeneration} now ${fetchGeneration} - discarding`);
          return;
        }
        // GQL response: array wrapper -> [0].data.video.comments.edges
        const gql = JSON.parse(raw);
        const comments = gql?.[0]?.data?.video?.comments;
        const edges = comments?.edges || [];
        // Comments that actually made it into the queue this fetch -
        // dupes filtered by seenComments don't count. This, not
        // fetchedUpTo movement, is what "progress" means below: an
        // overlap page can contain a few new comments without moving the
        // frontier, and a re-walked page can move nothing at all.
        let newCount = 0;
        for (const edge of edges) {
          const node = edge.node;
          const offset = node?.contentOffsetSeconds ?? 0;
          const user = node?.commenter?.displayName || "unknown";
          const userId = node?.commenter?.id ?? null;
          const color = node?.message?.userColor || "#9147ff";

          // One-time diagnostic: this query is a Twitch persisted query
          // (see get_vod_chat in main.rs), so its exact field selection is
          // fixed server-side, not something this app can request more
          // fields from directly. commenter.id is a reasonable-confidence
          // guess (Twitch's own VOD player needs SOME id to support its
          // own clickable-username feature in replay, which this is
          // mirroring) rather than a confirmed field name - if it's ever
          // actually missing, this logs the real commenter shape once so
          // fixing the field name doesn't mean guessing blind again.
          if (userId == null && !this._loggedMissingCommenterId) {
            this._loggedMissingCommenterId = true;
            console.warn("[vod-chat] commenter.id missing - user cards won't work in VOD replay. Raw commenter object:", JSON.stringify(node?.commenter));
          }

          // Body + emotes tag reconstructed from the GQL message
          // fragments - see reconstructVodMessage in emote-parsing.js
          // (pure and unit-tested there).
          const { body, emotesTag } = reconstructVodMessage(node?.message?.fragments);

          // Convert GQL userBadges to the same "setId/version,..." string
          // format the IRC `badges` tag uses, so renderBadges() can look
          // them up in badgeMap identically to live chat. GQL gives an
          // array like [{setID:"subscriber",version:"12"},...]
          const rawBadges = node?.message?.userBadges || [];
          const badgesTag = rawBadges.length > 0
            ? rawBadges.map(b => `${b.setID}/${b.version}`).join(",")
            : null;

          // Prefer the GQL node's own id for dedupe; fall back to a
          // composite that's unique enough in practice (two identical
          // bodies from the same user in the same second is exactly what
          // Twitch's own duplicate-message block prevents). Same
          // one-time-diagnostic pattern as commenter.id above, since the
          // persisted query's field selection is fixed server-side and
          // node.id being present is likewise inferred, not guaranteed.
          const dedupeKey = node?.id ?? `${offset}|${user}|${body}`;
          if (node?.id == null && !this._loggedMissingCommentNodeId) {
            this._loggedMissingCommentNodeId = true;
            console.warn("[vod-chat] comment node.id missing - deduping by offset|user|body composite instead. Raw node keys:", JSON.stringify(Object.keys(node || {})));
          }
          if (body && !seenComments.has(dedupeKey)) {
            seenComments.add(dedupeKey);
            queue.push({ offset, user, userId, color, body, emotesTag, badgesTag });
            newCount++;
          }
          if (offset > fetchedUpTo) fetchedUpTo = offset;
        }
        // Bound dedupe memory on very long sessions: past 20k entries
        // (hours of busy chat), drop the oldest half - Sets iterate in
        // insertion order, and anything that old is far behind both
        // playback and the frontier, so re-seeing it is no longer
        // possible outside a seek (which replaces the Set wholesale
        // anyway - see resetAndFetch).
        if (seenComments.size > 20_000) {
          let toDrop = seenComments.size / 2;
          for (const key of seenComments) {
            if (toDrop-- <= 0) break;
            seenComments.delete(key);
          }
        }
        // Cursor for next page is the last edge's cursor value;
        // hasNextPage tells us whether to keep fetching.
        const hasNext = comments?.pageInfo?.hasNextPage ?? false;
        fetchCursor = hasNext && edges.length > 0
          ? edges[edges.length - 1].cursor
          : "";
        // hasNextPage:false means THIS cursor chain is exhausted - not
        // necessarily that the VOD has no more comments anywhere ahead
        // (see cursorExhausted's declaration above for why). Tracked
        // separately from fetchCursor itself, which is also legitimately
        // empty right after a fresh offset-based fetch that still has
        // more pages (cursor is only assigned once a page is consumed).
        cursorExhausted = !hasNext;
        if (newCount > 0) {
          // Genuinely new comments made it into the queue - that's
          // progress no matter what fetchedUpTo did, so clear all stall
          // tracking and keep retries (if any are even needed) snappy.
          exhaustedRetryDelay = 1000;
          stuckOffsetNudge = 0;
        } else if (hasNext && fetchCursor && fetchCursor !== pageCursorBefore) {
          // Zero new comments, but the cursor advanced: we're re-walking
          // already-fetched ground toward the frontier. This is the
          // normal, expected aftermath of any offset-based fetch that
          // landed at or before fetchedUpTo (Twitch returns the page
          // CONTAINING the requested offset - see seenComments'
          // declaration), NOT a stall - the old code couldn't tell these
          // apart and punished this case with backoff too. Do nothing;
          // the regular cursor pre-fetch in tick() keeps paging and the
          // chain reaches unseen comments within a page or two.
        } else {
          // Chain dead-ended (hasNext=false or cursor stuck returning the
          // same page): searching again returns the same answer, so nudge the
          // offset forward immediately rather than backing off. Retries stay
          // at 1s while inside the lookahead window (the viewer is owed those
          // comments); only slow down once the whole window comes back empty.
          fetchCursor = "";
          cursorExhausted = true;
          stuckOffsetNudge = Math.min(stuckOffsetNudge + 5, 60);
          const posNow = getPosition();
          const nextRetryOffset = Math.max(fetchedUpTo, posNow) + stuckOffsetNudge;
          if (nextRetryOffset > posNow + LOOKAHEAD_S) {
            exhaustedRetryDelay = Math.min(exhaustedRetryDelay * 2, 30_000);
          } else {
            exhaustedRetryDelay = 1000;
          }
          console.log(`[vod-chat] ${_ts()} fetchPage(${fromSeconds.toFixed(1)}) NO WAY FORWARD on this chain (got=${edges.length}, all seen, hasNext=${hasNext}) - next search offset +${stuckOffsetNudge}s, delay=${(exhaustedRetryDelay/1000).toFixed(1)}s`);
        }
        const offsets = edges.length > 0
          ? `${edges[0].node?.contentOffsetSeconds}..${edges[edges.length-1].node?.contentOffsetSeconds}`
          : "none";
        console.log(`[vod-chat] ${_ts()} fetchPage(${fromSeconds.toFixed(1)}) DONE in ${elapsed}s  got=${edges.length} new=${newCount} offsets=${offsets}  hasNext=${hasNext}  fetchedUpTo=${fetchedUpTo}  queue=${queue.length}`);
      } catch (err) {
        console.log(`[vod-chat] ${_ts()} fetchPage(${fromSeconds.toFixed(1)}) ERROR: ${err}`);
        if (!stopped) this.systemLine(`Chat replay error: ${err}`);
      } finally {
        fetching = false;
      }
    };

    // Initial fetch. Uses initialPositionSecs (the actual position
    // playback is starting/resuming/seeking to), NOT a hardcoded 0 -
    // fetching from 0 regardless of the real start position was the
    // actual cause of "chat won't load" after a live-DVR seek deep into
    // a long stream: nothing else ever tells this replay loop where
    // that seek landed (attachHlsDvr only sets HLS.js's own
    // startPosition, it doesn't notify chat), so with a hardcoded 0 the
    // pre-fetch loop below had to page through the ENTIRE cursor chain
    // from the very start of the stream one page at a time before ever
    // reaching messages near the actual playback position - for a many-
    // hour stream with active chat, that's thousands of sequential
    // round-trips, easily outpacing how fast the user can seek around
    // and explore, so chat visibly never caught up.
    console.log(`[vod-chat] ${_ts()} initial fetchPage(${initialPositionSecs})`);
    await fetchPage(initialPositionSecs);
    if (stopped) return;
    // Same wall-clock anchor as resetAndFetch.
    if (lastExhaustedRetryAt === -Infinity) lastExhaustedRetryAt = performance.now();
    // Arms the sync-wait for startup, same as every other reset does via
    // resetAndFetch - see awaitingPositionSync's own declaration.
    awaitingPositionSync = true;
    expectedPosition = initialPositionSecs;
    _syncWaitStartedAt = performance.now();
    this.container.innerHTML = "";
    this.setStatus("replay");
    console.log(`[vod-chat] ${_ts()} replay loop started  fetchedUpTo=${fetchedUpTo}  queue=${queue.length}`);

    // How close pos needs to get to expectedPosition to count as "caught
    // up" - see awaitingPositionSync's declaration for the full picture.
    const POSITION_SYNC_TOLERANCE_S = 3;
    // Safety-net cap in case position never actually converges on
    // expectedPosition for some other reason (a genuine bug elsewhere,
    // a VOD that fails to load, etc.) - without this, seek-detection
    // would stay disabled forever rather than eventually trusting
    // whatever position it does have. 45s comfortably covers even a
    // very slow VOD/manifest load (worse than the 15s seen in testing)
    // while still bounding the wait to something finite.
    const POSITION_SYNC_TIMEOUT_MS = 45_000;

    const tick = async () => {
      if (stopped) return;

      const pos = getPosition();
      _tickN++;
      // Compact state summary every ~2s (every 4th tick at CHECK_MS=500)
      if (_tickN % 4 === 0) {
        console.log(`[vod-chat] ${_ts()} tick#${_tickN}  pos=${pos.toFixed(1)}  fetchedUpTo=${fetchedUpTo}  queue=${queue.length}  fetching=${fetching}  cursor=${fetchCursor ? "set" : "empty"}  exhausted=${cursorExhausted}`);
      }

      // Was still waiting for position to catch up BEFORE this tick's own
      // check below - captured up front so seek-detection is skipped for
      // the entire tick where sync first gets confirmed too (using that
      // freshly-confirmed pos as next tick's baseline, rather than
      // risking a same-tick comparison against a not-yet-updated
      // lastPosition).
      const wasAwaitingSync = awaitingPositionSync;
      if (awaitingPositionSync) {
        const closeEnough = Math.abs(pos - expectedPosition) < POSITION_SYNC_TOLERANCE_S;
        const timedOut = performance.now() - _syncWaitStartedAt > POSITION_SYNC_TIMEOUT_MS;
        if (closeEnough || timedOut) {
          console.log(`[vod-chat] ${_ts()} position synced  pos=${pos.toFixed(1)}  expected=${expectedPosition.toFixed(1)}  timedOut=${timedOut}`);
          awaitingPositionSync = false;
        }
      }

      // Detect backward seek: position jumped back more than 5s.
      if (!wasAwaitingSync && lastPosition >= 0 && pos < lastPosition - 5) {
        console.log(`[vod-chat] ${_ts()} BACKWARD SEEK detected  pos=${pos.toFixed(1)} < lastPos=${lastPosition.toFixed(1)}-5`);
        await resetAndFetch(pos);
      }
      // Detect a forward seek: position jumped further than one tick could
      // produce. Compared against lastPosition, not fetchedUpTo (which
      // plateaus on quiet stretches and looked like a seek). The 5s pad
      // clears polling jitter (position refreshes every 1000ms vs this 500ms
      // tick) while still catching real seeks. On a real seek the stale
      // fetchCursor is cleared and re-fetched from scratch.
      else if (!wasAwaitingSync && lastPosition >= 0 && pos > lastPosition + (CHECK_MS / 1000) + 5) {
        console.log(`[vod-chat] ${_ts()} FORWARD SEEK (poll) detected  pos=${pos.toFixed(1)} > lastPos=${lastPosition.toFixed(1)}+threshold`);
        await resetAndFetch(pos);
      }
      lastPosition = pos;

      // Pre-fetch next page when the queue is running low relative to
      // lookahead. Two cases, both needing more data fetched:
      //   1. Normal continuation: fetchCursor is set, just keep paging
      //      through it as before.
      //   2. Cursor exhausted (hasNextPage was false) but there's still
      //      runway before LOOKAHEAD_S - retry with a FRESH offset-based
      //      fetch (fetchCursor="" forces this - see fetchPage's cursor
      //      handling) rather than concluding there's nothing left.
      //      Confirmed via real testing that Twitch's cursor chains can
      //      end well before a VOD actually does, and a fresh
      //      offset-based query past that point successfully finds more
      //      comments - this was the actual cause of chat silently
      //      stopping ~30s after a seek landed near wherever this VOD's
      //      particular cursor chain happened to end. Throttled to
      //      roughly once per LOOKAHEAD_S of playback so a genuinely
      //      comment-free tail of the VOD doesn't retry every single tick.
      if (!fetching && fetchedUpTo < pos + LOOKAHEAD_S) {
        if (fetchCursor !== "") {
          console.log(`[vod-chat] ${_ts()} PRE-FETCH (cursor)  pos=${pos.toFixed(1)}  fetchedUpTo=${fetchedUpTo}`);
          fetchPage(pos);
        } else if (fetchedUpTo === -1 && !cursorExhausted) {
          // Recovery for a dropped initial fetch: rapid seeks can make
          // resetAndFetch()'s fetchPage() no-op (its `if (fetching) return`
          // guard), leaving the loop stuck at fetchCursor="" /
          // cursorExhausted=false with no other branch retrying. This retries
          // until a real fetch confirms empty (then cursorExhausted flips and
          // the backoff branch below takes over).
          console.log(`[vod-chat] ${_ts()} PRE-FETCH (recover stalled reset)  pos=${pos.toFixed(1)}`);
          fetchPage(pos);
        } else if (cursorExhausted && performance.now() - lastExhaustedRetryAt >= exhaustedRetryDelay) {
          // Search offset: the frontier (fetchedUpTo) or the current
          // playback position, whichever is further along - NOT pos
          // alone (pos can be well behind fetchedUpTo when the video is
          // playing through content already in the queue; dedupe would
          // make re-fetching that range harmless now, but it's still a
          // wasted request), and NOT fetchedUpTo alone either (during a
          // long quiet stretch playback overtakes the frontier, and
          // anchoring the search to the stale frontier instead of
          // following playback meant the nudge cap could strand the
          // search far behind where the viewer actually is). Plus the
          // forward-search nudge - see its declaration and fetchPage's
          // no-way-forward branch for how the two-part scheme
          // (fast-nudge inside the lookahead window, backoff only beyond
          // it) replaced the old always-backoff behavior.
          const retryOffset = Math.max(fetchedUpTo, pos) + stuckOffsetNudge;
          console.log(`[vod-chat] ${_ts()} PRE-FETCH (exhausted retry)  pos=${pos.toFixed(1)}  fetchedUpTo=${fetchedUpTo}  retryOffset=${retryOffset}  secSinceLastRetry=${((performance.now()-lastExhaustedRetryAt)/1000).toFixed(1)}  delay=${(exhaustedRetryDelay/1000).toFixed(1)}s`);
          lastExhaustedRetryAt = performance.now();
          fetchPage(retryOffset);
        }
      }

      // Flush all queued messages whose timestamp has passed. Each
      // render is individually guarded: shift() has already removed the
      // message, so a renderer exception on one poison message costs
      // exactly that message (with a log naming it) instead of
      // re-throwing on the same queue head forever.
      let rendered = 0;
      while (queue.length > 0 && queue[0].offset <= pos) {
        const msg = queue.shift();
        try {
          this.renderMessage(msg.user, msg.color, msg.body,
            /*badgesTag=*/msg.badgesTag ?? null, /*bits=*/0, /*customRewardId=*/null,
            /*replyParentUser=*/null, /*replyParentBody=*/null,
            /*msgId=*/null, /*userId=*/msg.userId ?? null, /*isAction=*/false,
            msg.emotesTag, /*isFirstMsg=*/false);
        } catch (err) {
          console.error(`[vod-chat] renderMessage threw for a message from "${msg.user}" at ${msg.offset}s - skipping it:`, err, JSON.stringify(msg.body));
        }
        rendered++;
        if (rendered > 50) break; // cap burst after a seek
      }
      if (rendered > 0) {
        console.log(`[vod-chat] ${_ts()} flushed ${rendered} msgs  pos=${pos.toFixed(1)}  queue=${queue.length} remaining`);
      }
    };

    // The loop is a recursive setTimeout chain, and re-scheduling MUST
    // be unconditional (hence the wrapper + finally rather than a plain
    // `setTimeout(tick)` at the end of tick itself, which is how this
    // used to work): tick is async, so any exception that escaped it -
    // one weird message hitting a renderer edge case, a position read
    // during player teardown, anything - rejected the promise BEFORE
    // the old tail-call reschedule ran, silently killing the entire
    // replay loop for the rest of the session. Confirmed as the cause
    // of VOD chat intermittently "crashing completely": whatever threw
    // was rare and timing-dependent, but one throw was permanent death.
    // Now it costs one logged tick out of every ~2/second.
    const tickLoop = async () => {
      try {
        await tick();
      } catch (err) {
        console.error(`[vod-chat] ${_ts()} tick threw (loop continues):`, err);
      } finally {
        if (!stopped) setTimeout(tickLoop, CHECK_MS);
      }
    };
    setTimeout(tickLoop, CHECK_MS);
  },
};
