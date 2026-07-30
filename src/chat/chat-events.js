// Rich Twitch event rendering: subs, gifts, raids, bits, Hype Train, and
// Predictions. Platform-agnostic (rides the chat/EventSub pipeline in Rust).
//
// Sources: IRC USERNOTICE ("chat-usernotice") for subs/gifts/raids/announce,
// works on any channel; EventSub ("eventsub-hypetrain"/"-prediction") for
// Hype Train + Predictions, which need broadcaster-only scopes so they only
// fire on your own channel. Bits ride the normal chat-message path.
//
// Most events render as a .chat-line via trimAndScroll(); Hype Train and
// Predictions instead use a persistent overlay pinned above the chat body.

export const chatEventsMixin = {
  // Wires up the USERNOTICE + EventSub listeners; call once from connect.
  async _initEventListeners(listen) {
    this.unlisteners.push(
      await listen("chat-usernotice", (e) => this.renderUsernotice(e.payload)),
    );
    this.unlisteners.push(
      await listen("eventsub-hypetrain", (e) => this.renderHypeTrain(e.payload)),
    );
    this.unlisteners.push(
      await listen("eventsub-prediction", (e) => this.renderPrediction(e.payload)),
    );
  },

  // ── USERNOTICE (subs / resubs / gifts / raids / announcements) ──────────

  renderUsernotice(p) {
    switch (p.msg_id) {
      case "sub":
      case "resub":
        this._renderSubEvent(p);
        break;
      case "subgift":
        this._renderGiftSubEvent(p);
        break;
      case "submysterygift":
        this._renderMysteryGiftEvent(p);
        break;
      case "raid":
        this._renderRaidBanner(p);
        break;
      case "announcement":
        this._renderAnnouncement(p);
        break;
      // Anything else: fall back to Twitch's system-msg.
      default:
        if (p.system_msg) this._renderGenericEvent(p.system_msg);
    }
  },

  _planLabel(plan) {
    // sub-plan values: "Prime", "1000", "2000", "3000".
    if (!plan) return "";
    if (plan === "Prime") return "Prime";
    return { "1000": "Tier 1", "2000": "Tier 2", "3000": "Tier 3" }[plan] || "";
  },

  _renderSubEvent(p) {
    const line = this._eventLine("chat-event sub-event");
    line.appendChild(this._icon("sub-event-icon", "★"));

    const info = document.createElement("span");
    info.className = "chat-event-info";

    info.appendChild(this._name(p.display_name));

    const months = p.cumulative_months || 0;
    const plan = this._planLabel(p.sub_plan);
    const planText = plan ? ` (${plan})` : "";
    const verb = p.msg_id === "resub" ? "resubscribed" : "subscribed";
    const monthsText = months > 1 ? ` for ${months} months` : "";
    const streakText = p.streak_months ? `, ${p.streak_months}-month streak` : "";
    info.appendChild(document.createTextNode(`${" "}${verb}${planText}${monthsText}${streakText}`));

    line.appendChild(info);

    // The user's attached resub message, rendered with emote support.
    if (p.user_message) {
      const msg = document.createElement("div");
      msg.className = "chat-event-message";
      msg.appendChild(this.renderMessageBody(p.user_message, p.emotes_tag));
      line.appendChild(msg);
    }
    this._appendEvent(line);
  },

  _renderGiftSubEvent(p) {
    const line = this._eventLine("chat-event gift-event");
    line.appendChild(this._icon("gift-event-icon", "🎁"));
    const info = document.createElement("span");
    info.className = "chat-event-info";
    info.appendChild(this._name(p.display_name));
    const plan = this._planLabel(p.sub_plan);
    const planText = plan ? ` ${plan}` : "";
    info.appendChild(document.createTextNode(` gifted a${planText} sub to `));
    info.appendChild(this._name(p.recipient || "someone"));
    line.appendChild(info);
    this._appendEvent(line);
  },

  _renderMysteryGiftEvent(p) {
    const line = this._eventLine("chat-event gift-event mass-gift-event");
    line.appendChild(this._icon("gift-event-icon", "🎁"));
    const info = document.createElement("span");
    info.className = "chat-event-info";
    info.appendChild(this._name(p.display_name));
    const count = p.gift_count || 0;
    const plan = this._planLabel(p.sub_plan);
    const planText = plan ? ` ${plan}` : "";
    info.appendChild(document.createTextNode(
      ` is gifting ${count} ${planText} sub${count === 1 ? "" : "s"} to the community!`,
    ));
    line.appendChild(info);
    this._appendEvent(line);
  },

  _renderRaidBanner(p) {
    const line = this._eventLine("chat-event raid-event");
    line.appendChild(this._icon("raid-event-icon", "⚔"));
    const info = document.createElement("span");
    info.className = "chat-event-info";
    info.appendChild(this._name(p.display_name));
    const n = p.raider_count || 0;
    info.appendChild(document.createTextNode(
      ` is raiding with a party of ${n.toLocaleString()}!`,
    ));
    line.appendChild(info);
    this._appendEvent(line);
  },

  _renderAnnouncement(p) {
    const line = this._eventLine("chat-event announcement-event");
    // Announcements carry a color band (PRIMARY/BLUE/GREEN/ORANGE/PURPLE).
    const color = (p.announcement_color || "PRIMARY").toLowerCase();
    line.classList.add(`announcement-${color}`);
    const info = document.createElement("span");
    info.className = "chat-event-info";
    info.appendChild(this._name(p.display_name));
    info.appendChild(document.createTextNode(": "));
    if (p.user_message) {
      info.appendChild(this.renderMessageBody(p.user_message, p.emotes_tag));
    } else if (p.system_msg) {
      info.appendChild(document.createTextNode(p.system_msg));
    }
    line.appendChild(info);
    this._appendEvent(line);
  },

  _renderGenericEvent(text) {
    const line = this._eventLine("chat-event generic-event");
    const info = document.createElement("span");
    info.className = "chat-event-info";
    info.textContent = text;
    line.appendChild(info);
    this._appendEvent(line);
  },

  // ── Bits / cheers ───────────────────────────────────────────────────────
  // Bits render inline in chat.js renderMessage (see the `has-bits` block).

  // ── Hype Train overlay ──────────────────────────────────────────────────

  renderHypeTrain(p) {
    const ev = p.event || {};
    if (p.phase === "end") {
      this._dismissOverlay("hype-train-overlay", 6000);
      return;
    }
    const overlay = this._ensureOverlay("hype-train-overlay");
    const level = ev.level || 1;
    const total = ev.total || 0;
    const goal = ev.goal || 0;
    const pct = goal > 0 ? Math.min(100, Math.round((ev.progress || 0) / goal * 100)) : 0;
    const expires = ev.expires_at ? new Date(ev.expires_at).getTime() : 0;

    overlay.innerHTML = `
      <div class="hype-train-header">
        <span class="hype-train-emoji">🚂</span>
        <span class="hype-train-title">Hype Train</span>
        <span class="hype-train-level">Level ${level}</span>
        <span class="hype-train-countdown" data-expires="${expires}"></span>
      </div>
      <div class="hype-train-bar"><div class="hype-train-fill" style="width:${pct}%"></div></div>
      <div class="hype-train-progress">${total.toLocaleString()} / ${goal.toLocaleString()}</div>
    `;
    this._startCountdown(overlay);
  },

  // ── Predictions overlay ─────────────────────────────────────────────────

  renderPrediction(p) {
    const ev = p.event || {};
    if (p.phase === "end") {
      // Resolve: highlight the winning outcome, then dismiss.
      const overlay = this._ensureOverlay("prediction-overlay");
      const winId = ev.winning_outcome_id;
      overlay.querySelectorAll(".prediction-outcome").forEach((el) => {
        if (el.dataset.id === winId) el.classList.add("prediction-won");
        else el.classList.add("prediction-lost");
      });
      const status = overlay.querySelector(".prediction-status");
      if (status) status.textContent = ev.status === "canceled" ? "Canceled" : "Resolved";
      this._dismissOverlay("prediction-overlay", 8000);
      return;
    }

    const overlay = this._ensureOverlay("prediction-overlay");
    const title = ev.title || "Prediction";
    const outcomes = ev.outcomes || [];
    const locked = p.phase === "lock";
    const totalPoints = outcomes.reduce((s, o) => s + (o.channel_points || 0), 0);
    const expires = ev.locks_at ? new Date(ev.locks_at).getTime() : 0;

    const outcomeHtml = outcomes.map((o) => {
      const pts = o.channel_points || 0;
      const pct = totalPoints > 0 ? Math.round(pts / totalPoints * 100) : 0;
      const color = (o.color || "BLUE").toLowerCase();
      return `
        <div class="prediction-outcome outcome-${color}" data-id="${o.id}">
          <div class="prediction-outcome-fill" style="width:${pct}%"></div>
          <span class="prediction-outcome-title">${this._escape(o.title || "")}</span>
          <span class="prediction-outcome-pct">${pct}%</span>
          <span class="prediction-outcome-pts">${pts.toLocaleString()}</span>
        </div>`;
    }).join("");

    overlay.innerHTML = `
      <div class="prediction-header">
        <span class="prediction-emoji">🔮</span>
        <span class="prediction-title">${this._escape(title)}</span>
        <span class="prediction-status">${locked ? "Locked" : "Voting open"}</span>
        <span class="prediction-countdown" data-expires="${locked ? 0 : expires}"></span>
      </div>
      <div class="prediction-outcomes">${outcomeHtml}</div>
    `;
    if (!locked) this._startCountdown(overlay);
  },

  // ── Shared helpers ──────────────────────────────────────────────────────

  _eventLine(cls) {
    const line = document.createElement("div");
    line.className = `chat-line ${cls}`;
    return line;
  },

  _icon(cls, glyph) {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = glyph;
    return s;
  },

  _name(text) {
    const s = document.createElement("span");
    s.className = "chat-event-name";
    s.textContent = text;
    return s;
  },

  _appendEvent(line) {
    this.container.appendChild(line);
    this.trimAndScroll();
  },

  _escape(str) {
    const d = document.createElement("div");
    d.textContent = String(str);
    return d.innerHTML;
  },

  // Get-or-create a persistent overlay pinned above chat (they stack).
  _ensureOverlay(id) {
    let host = document.getElementById("chat-event-overlays");
    if (!host) {
      host = document.createElement("div");
      host.id = "chat-event-overlays";
      // Pin at the top of the chat pane.
      const pane = this.container.closest("#chat-pane") || this.container.parentElement;
      if (pane) pane.insertBefore(host, pane.firstChild);
    }
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.className = "chat-event-overlay";
      host.appendChild(el);
    }
    return el;
  },

  _dismissOverlay(id, delayMs) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el._countdownTimer) { clearInterval(el._countdownTimer); el._countdownTimer = null; }
    el.classList.add("chat-event-overlay-ending");
    setTimeout(() => el.remove(), delayMs);
  },

  // Drive the live "Xs left" countdown from a .*-countdown element's data-expires.
  _startCountdown(overlay) {
    if (overlay._countdownTimer) clearInterval(overlay._countdownTimer);
    const tick = () => {
      const el = overlay.querySelector("[data-expires]");
      if (!el) return;
      const expires = Number(el.dataset.expires) || 0;
      if (!expires) { el.textContent = ""; return; }
      const secs = Math.max(0, Math.round((expires - Date.now()) / 1000));
      el.textContent = `${secs}s`;
      if (secs <= 0) { clearInterval(overlay._countdownTimer); overlay._countdownTimer = null; }
    };
    tick();
    overlay._countdownTimer = setInterval(tick, 1000);
  },
};
