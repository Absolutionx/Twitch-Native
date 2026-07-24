// Twitch OAuth login (frontend side).
//
// The actual browser-based login flow happens in Rust (see oauth.rs) -
// this module just triggers it, listens for the resulting token via a
// Tauri event, and then validates it / stores the resulting login name so
// chat.js knows it can send messages.
//
// On startup, restore_session() is called automatically to re-use a
// previously-saved token without requiring the user to log in again.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export class TwitchAuth {
  constructor({ loginBtn, userMenuEl, userMenuSignout, statusCallback }) {
    this.loginBtn       = loginBtn;
    this.userMenuEl     = userMenuEl;
    this.userMenuSignout = userMenuSignout;
    this.statusCallback = statusCallback || (() => {});
    this.login = null; // lowercase Twitch username, once logged in

    this.loginBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.login) {
        this._toggleUserMenu();
      } else {
        this.startLogin();
      }
    });

    this.userMenuSignout?.addEventListener("click", () => {
      this._closeUserMenu();
      this.logout();
    });

    // Close the dropdown when clicking anywhere else.
    document.addEventListener("click", () => this._closeUserMenu());

    this.setupListener();
    this.tryRestoreSession();
  }

  _positionUserMenu() {
    const rect = this.loginBtn.getBoundingClientRect();
    this.userMenuEl.style.left  = "";
    this.userMenuEl.style.right = `${window.innerWidth - rect.right}px`;
    this.userMenuEl.style.top   = `${rect.bottom + 4}px`;
    this.userMenuEl.style.bottom = "";
  }

  _toggleUserMenu() {
    const opening = !this.userMenuEl.classList.contains("open");
    if (opening) this._positionUserMenu();
    this.userMenuEl.classList.toggle("open", opening);
  }

  _closeUserMenu() {
    this.userMenuEl?.classList.remove("open");
  }

  async setupListener() {
    await listen("oauth-token", async (event) => {
      const { access_token } = event.payload;
      await this.handleToken(access_token);
    });
  }

  // Fetches the user's display_name from Helix (properly cased, e.g.
  // "StreamerName" instead of "streamername") and updates the login
  // button. Falls back to the raw login string if the fetch fails so
  // we never leave the button blank. Returns the display_name (or
  // login as fallback) for callers that need to pass it along.
  async _resolveDisplayName(login, userId) {
    try {
      const users = JSON.parse(await invoke("get_users_info", { userIds: [userId] }));
      return users?.[0]?.display_name || login;
    } catch {
      return login;
    }
  }

  async tryRestoreSession() {
    try {
      this.loginBtn.textContent = "Restoring session…";
      this.loginBtn.disabled = true;

      const result = await invoke("restore_session");
      if (result) {
        const { access_token, login, user_id } = result;
        await invoke("set_oauth_credentials", { accessToken: access_token, login, userId: user_id });
        this.login = login;
        const displayName = await this._resolveDisplayName(login, user_id);
        this.loginBtn.textContent = displayName;
        this.loginBtn.classList.add("logged-in");
        this.loginBtn.disabled = false;
        this.statusCallback(login, user_id, displayName);
      } else {
        this.loginBtn.textContent = "Log in with Twitch";
        this.loginBtn.disabled = false;
      }
    } catch (err) {
      console.error("Session restore failed:", err);
      this.loginBtn.textContent = "Log in with Twitch";
      this.loginBtn.disabled = false;
    }
  }

  async startLogin() {
    try {
      this.loginBtn.textContent = "Logging in…";
      this.loginBtn.disabled = true;
      await invoke("start_oauth_login");
    } catch (err) {
      console.error("Failed to start login:", err);
      this.loginBtn.textContent = "Log in with Twitch";
      this.loginBtn.disabled = false;
    }
  }

  async logout() {
    try {
      await invoke("logout");
      await invoke("set_oauth_credentials", { accessToken: "", login: "", userId: "" });
    } catch (err) {
      console.error("Logout failed:", err);
    }
    this.login = null;
    this.loginBtn.textContent = "Log in with Twitch";
    this.loginBtn.classList.remove("logged-in");
    this.loginBtn.disabled = false;
    this.statusCallback(null, null, null);
  }

  async handleToken(accessToken) {
    try {
      const { login, user_id } = await invoke("validate_oauth_token", { accessToken });
      await invoke("set_oauth_credentials", { accessToken, login, userId: user_id });
      this.login = login;
      const displayName = await this._resolveDisplayName(login, user_id);
      this.loginBtn.textContent = displayName;
      this.loginBtn.classList.add("logged-in");
      this.loginBtn.disabled = false;
      this.statusCallback(login, user_id, displayName);
    } catch (err) {
      console.error("Token validation failed:", err);
      this.loginBtn.textContent = "Log in with Twitch";
      this.loginBtn.disabled = false;
    }
  }
}
