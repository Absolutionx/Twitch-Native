// Kick OAuth 2.1 (Authorization Code + PKCE) and authenticated chat send.
// Kick's counterpart to oauth.rs; see that file for the local-redirect-server
// strategy. Differences: authorization-code + PKCE (not implicit), requires a
// client secret even for PKCE, separate hosts (id.kick.com for auth,
// api.kick.com for REST, neither behind Cloudflare so plain reqwest works),
// and ~1h tokens refreshed on demand. Redirect port 17544 (Twitch uses 17543);
// register http://localhost:17544/ at https://kick.com/settings/developer.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

// ---------------------------------------------------------------------------
// App credentials (registered at https://kick.com/settings/developer)
// ---------------------------------------------------------------------------

// Public identifier, safe in source (same reasoning as oauth.rs's CLIENT_ID).
// Both credentials can also be supplied at BUILD time via environment
// variables (KICK_CLIENT_ID / KICK_CLIENT_SECRET), so a real secret never
// has to be committed to source: set them in the shell before running the
// build script and option_env! bakes them into the binary.
pub const CLIENT_ID: &str = match option_env!("KICK_CLIENT_ID") {
    Some(v) => v,
    None => "01KXA9BRSGK8QWV8G2F3RB46PZ",
};

// Kick demands this on the PKCE token exchange (see header note 2). It is
// NOT a real secret once shipped in a binary - treat it as a semi-public
// app identifier, and if it's abused, rotate it in the Kick dev console
// (a KICK_CLIENT_SECRET env var at build time still overrides this).
pub const CLIENT_SECRET: &str = match option_env!("KICK_CLIENT_SECRET") {
    Some(v) => v,
    None => "3eb07b640555e7aab2a115040c79733e68aba3b424fc42a54a0858411a12282c",
};

const REDIRECT_URI: &str = "http://localhost:17544/";
const REDIRECT_PORT: &str = "17544";

const AUTHORIZE_URL: &str = "https://id.kick.com/oauth/authorize";
const TOKEN_URL: &str = "https://id.kick.com/oauth/token";
const USERS_URL: &str = "https://api.kick.com/public/v1/users";
const CHAT_URL: &str = "https://api.kick.com/public/v1/chat";

// Scopes: user:read to identify the logged-in account (get_me for the
// local echo's display name), chat:write to send. Nothing else - this
// app doesn't moderate or manage the channel on Kick's side.
const SCOPES: &str = "user:read chat:write";

/// True once a real client secret has been filled in. The frontend hides
/// the Kick "Log in" button (and shows a short explainer) while this is
/// false, so a build shipped with the placeholder doesn't offer a login
/// that could only ever fail at the token exchange.
#[tauri::command]
pub fn kick_oauth_configured() -> bool {
    CLIENT_SECRET != "REPLACE_WITH_KICK_CLIENT_SECRET" && !CLIENT_ID.is_empty()
}

// ---------------------------------------------------------------------------
// Token persistence (mirrors oauth.rs, separate file so the two providers
// never clobber each other's stored token)
// ---------------------------------------------------------------------------

const TOKEN_FILE: &str = "kick_oauth_token.json";

#[derive(Serialize, Deserialize, Clone, Default)]
struct PersistedToken {
    access_token: String,
    refresh_token: String,
}

fn save_token(app: &AppHandle, tok: &PersistedToken) {
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    if let Ok(json) = serde_json::to_string(tok) {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(TOKEN_FILE), json);
    }
}

fn load_token(app: &AppHandle) -> Option<PersistedToken> {
    let dir = app.path().app_local_data_dir().ok()?;
    let json = std::fs::read_to_string(dir.join(TOKEN_FILE)).ok()?;
    serde_json::from_str(&json).ok()
}

fn clear_token_file(app: &AppHandle) {
    if let Ok(dir) = app.path().app_local_data_dir() {
        let _ = std::fs::remove_file(dir.join(TOKEN_FILE));
    }
}

// ---------------------------------------------------------------------------
// In-flight PKCE state (between authorize redirect and token exchange)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct PendingAuth {
    verifier: String,
    state: String,
}

// One login at a time; a new start_kick_oauth_login overwrites any
// abandoned prior attempt. Global rather than per-call because the
// redirect arrives on a separate connection to the local server, with
// no handle back to the command that started the flow.
static PENDING: Mutex<Option<PendingAuth>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// PKCE + random helpers
// ---------------------------------------------------------------------------

/// Self-contained SHA-256 (FIPS 180-4). Inlined rather than pulling in
/// the `sha2` crate: PKCE needs exactly one hash of one short string per
/// login, so a ~40-line dependency-free implementation is the right
/// trade - it also keeps the crate's transitive tree (and its
/// toolchain-version requirements) smaller. Verified against the RFC
/// 7636 test vector in this module's tests.
fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    // Pad: append 0x80, then zeros, then 64-bit big-endian bit length.
    let bitlen = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bitlen.to_be_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, wi) in w.iter_mut().enumerate().take(16) {
            let j = i * 4;
            *wi = u32::from_be_bytes([chunk[j], chunk[j + 1], chunk[j + 2], chunk[j + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ ((!v[4]) & v[6]);
            let t1 = v[7]
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [
                t1.wrapping_add(t2),
                v[0],
                v[1],
                v[2],
                v[3].wrapping_add(t1),
                v[4],
                v[5],
                v[6],
            ];
        }
        for i in 0..8 {
            h[i] = h[i].wrapping_add(v[i]);
        }
    }

    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

/// URL-safe base64 without padding (RFC 7636 code_challenge encoding).
fn b64url_nopad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4 + 2) / 3);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 63) as usize] as char);
        }
    }
    out
}

/// A high-entropy random token, base64url-encoded. Used for both the
/// PKCE code_verifier and the CSRF state. Sourced from the OS RNG via
/// getrandom (already in the dependency tree transitively; added
/// explicitly in Cargo.toml).
fn random_token(nbytes: usize) -> String {
    let mut buf = vec![0u8; nbytes];
    getrandom::getrandom(&mut buf).expect("OS RNG unavailable");
    b64url_nopad(&buf)
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Login: open browser + catch the ?code= redirect
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct KickAuthResultEvent {
    ok: bool,
    /// Logged-in account's Kick username (for the local echo), when ok.
    login: Option<String>,
    /// Present when !ok - a short reason for the status line.
    error: Option<String>,
}

/// Opens Kick's authorize page in the default browser and starts the
/// local redirect server. On success emits "kick-oauth-result" with
/// {ok:true, login} to the main window; on any failure the same event
/// with {ok:false, error}. (Twitch's oauth.rs emits a bare token and
/// lets the frontend validate; here the exchange is server-side, so this
/// reports the final outcome directly.)
#[tauri::command]
pub async fn start_kick_oauth_login(app: AppHandle) -> Result<(), String> {
    if !kick_oauth_configured() {
        return Err("Kick login isn't configured in this build.".into());
    }

    let verifier = random_token(48);
    let challenge = b64url_nopad(&sha256(verifier.as_bytes()));
    let state = random_token(24);

    *PENDING.lock().unwrap() = Some(PendingAuth {
        verifier,
        state: state.clone(),
    });

    let auth_url = format!(
        "{AUTHORIZE_URL}?response_type=code&client_id={}&redirect_uri={}\
         &scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        urlencode(CLIENT_ID),
        urlencode(REDIRECT_URI),
        urlencode(SCOPES),
        urlencode(&challenge),
        urlencode(&state),
    );

    let listener = match TcpListener::bind(format!("127.0.0.1:{REDIRECT_PORT}")).await {
        Ok(l) => l,
        Err(_) => {
            // Port busy: a prior attempt's server is still up. Reopen the
            // URL so the user can complete it against that server.
            open_browser(&app, &auth_url)?;
            return Ok(());
        }
    };

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(300),
            run_redirect_server(listener, app2),
        )
        .await;
    });

    open_browser(&app, &auth_url)?;
    Ok(())
}

fn open_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {e}"))
}

const DONE_HTML_OK: &str =
    "<!DOCTYPE html><meta charset=utf-8><title>Kick login</title>\
     <body style='background:#0e0e10;color:#efeff1;font-family:system-ui;\
     display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>\
     <div style='text-align:center'><h1 style='color:#53fc18'>Kick login successful</h1>\
     <p style='color:#adadb8'>You can close this tab and return to the app.</p></div>";

const DONE_HTML_ERR: &str =
    "<!DOCTYPE html><meta charset=utf-8><title>Kick login</title>\
     <body style='background:#0e0e10;color:#efeff1;font-family:system-ui;\
     display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>\
     <div style='text-align:center'><h1 style='color:#e91916'>Kick login failed</h1>\
     <p style='color:#adadb8'>Please close this tab and try again.</p></div>";

async fn run_redirect_server(listener: TcpListener, app: AppHandle) {
    // Only one meaningful request: the browser hitting the redirect URI
    // with ?code&state. Loop so a stray favicon/preflight before it
    // doesn't end the server prematurely.
    loop {
        let Ok((mut socket, _)) = listener.accept().await else {
            break;
        };
        let mut buf = vec![0u8; 8192];
        let n = socket.read(&mut buf).await.unwrap_or(0);
        if n == 0 {
            continue;
        }
        let first_line = String::from_utf8_lossy(&buf[..n])
            .lines()
            .next()
            .unwrap_or("")
            .to_string();
        if !first_line.starts_with("GET /") || first_line.contains("favicon") {
            continue;
        }

        let query = first_line
            .split_whitespace()
            .nth(1)
            .and_then(|p| p.split('?').nth(1))
            .unwrap_or("");
        let (mut code, mut state) = (None, None);
        for kv in query.split('&') {
            if let Some(v) = kv.strip_prefix("code=") {
                code = Some(url_decode(v));
            } else if let Some(v) = kv.strip_prefix("state=") {
                state = Some(url_decode(v));
            }
        }

        let outcome = finish_login(&app, code, state).await;
        let (status, body) = match &outcome {
            Ok(_) => ("200 OK", DONE_HTML_OK),
            Err(_) => ("200 OK", DONE_HTML_ERR),
        };
        let resp = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(resp.as_bytes()).await;

        let _ = app.emit(
            "kick-oauth-result",
            match outcome {
                Ok(login) => KickAuthResultEvent {
                    ok: true,
                    login: Some(login),
                    error: None,
                },
                Err(e) => KickAuthResultEvent {
                    ok: false,
                    login: None,
                    error: Some(e),
                },
            },
        );
        break; // one-shot
    }
}

/// Validate state, exchange the code, persist tokens, fetch the username.
/// Returns the login on success.
async fn finish_login(
    app: &AppHandle,
    code: Option<String>,
    state: Option<String>,
) -> Result<String, String> {
    let pending = PENDING.lock().unwrap().take();
    let Some(pending) = pending else {
        return Err("no login in progress".into());
    };
    let code = code.ok_or("authorization was denied or cancelled")?;
    // CSRF: the state we get back must equal the one we sent.
    if state.as_deref() != Some(pending.state.as_str()) {
        return Err("state mismatch (possible CSRF) - login aborted".into());
    }

    let tok = exchange_code(&code, &pending.verifier).await?;
    save_token(app, &tok);
    // Best-effort username; login still counts as successful even if this
    // read fails (send works off broadcaster_user_id, not our name).
    let login = fetch_username(&tok.access_token).await.unwrap_or_default();
    Ok(login)
}

// ---------------------------------------------------------------------------
// Token exchange / refresh (id.kick.com - NOT Cloudflare-fronted)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
}

async fn post_form(url: &str, form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .form(form)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("token endpoint returned {status}: {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("bad token response: {e}"))
}

async fn exchange_code(code: &str, verifier: &str) -> Result<PersistedToken, String> {
    let t = post_form(
        TOKEN_URL,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("redirect_uri", REDIRECT_URI),
            ("code_verifier", verifier),
            ("code", code),
        ],
    )
    .await?;
    Ok(PersistedToken {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
    })
}

async fn refresh(refresh_token: &str) -> Result<PersistedToken, String> {
    if refresh_token.is_empty() {
        return Err("no refresh token stored".into());
    }
    let t = post_form(
        TOKEN_URL,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("refresh_token", refresh_token),
        ],
    )
    .await?;
    Ok(PersistedToken {
        access_token: t.access_token,
        // Kick rotates the refresh token on use; fall back to the old one
        // only if the response omitted a new one.
        refresh_token: if t.refresh_token.is_empty() {
            refresh_token.to_string()
        } else {
            t.refresh_token
        },
    })
}

async fn fetch_username(access_token: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(USERS_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("users endpoint returned {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    // Public API wraps results as {data: [...]}. The current user is the
    // sole entry; name is the display username.
    json.pointer("/data/0/name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no username in users response".into())
}

// ---------------------------------------------------------------------------
// Session commands used by the frontend
// ---------------------------------------------------------------------------

/// On startup: if a stored Kick token still identifies a user, report the
/// login so the UI can show the logged-in state and enable Kick chat
/// input. A failed read triggers one refresh attempt before giving up.
/// Returns the login string, or Null if not logged in / unrecoverable.
#[tauri::command]
pub async fn restore_kick_session(app: AppHandle) -> Result<serde_json::Value, String> {
    let Some(mut tok) = load_token(&app) else {
        return Ok(serde_json::Value::Null);
    };
    // Try the stored access token; on failure, refresh once and retry.
    if let Ok(login) = fetch_username(&tok.access_token).await {
        return Ok(serde_json::json!({ "login": login }));
    }
    match refresh(&tok.refresh_token).await {
        Ok(fresh) => {
            tok = fresh;
            save_token(&app, &tok);
            match fetch_username(&tok.access_token).await {
                Ok(login) => Ok(serde_json::json!({ "login": login })),
                Err(_) => {
                    clear_token_file(&app);
                    Ok(serde_json::Value::Null)
                }
            }
        }
        Err(_) => {
            clear_token_file(&app);
            Ok(serde_json::Value::Null)
        }
    }
}

#[tauri::command]
pub fn kick_logout(app: AppHandle) {
    clear_token_file(&app);
}

// ---------------------------------------------------------------------------
// Send a chat message (api.kick.com - NOT Cloudflare-fronted)
// ---------------------------------------------------------------------------

/// POST one chat message to `broadcaster_user_id`'s channel as the
/// logged-in Kick user. On a 401 (expired access token) this refreshes
/// once and retries, so a stale token after ~1h idle heals silently
/// instead of surfacing as a failed send.
///
/// broadcaster_user_id comes from KickLiveInfo (kick.rs) - the frontend
/// passes through the value it already has for the channel being watched,
/// so this command needs no channel lookup of its own.
#[tauri::command]
pub async fn kick_send_chat_message(
    app: AppHandle,
    broadcaster_user_id: u64,
    message: String,
) -> Result<(), String> {
    let text = message.trim();
    if text.is_empty() {
        return Err("empty message".into());
    }
    // Kick's chat message cap is 500 chars; reject early with a clear
    // reason rather than letting the API 422.
    if text.chars().count() > 500 {
        return Err("message exceeds Kick's 500-character limit".into());
    }

    let mut tok = load_token(&app).ok_or("not logged in to Kick")?;

    match post_chat(&tok.access_token, broadcaster_user_id, text).await {
        Ok(()) => Ok(()),
        Err(SendError::Unauthorized) => {
            // Access token likely expired - refresh and retry once.
            tok = refresh(&tok.refresh_token).await.map_err(|e| {
                // Refresh failed too: the session is dead. Clear it so the
                // UI can drop back to logged-out on its next check.
                clear_token_file(&app);
                format!("Kick session expired, please log in again ({e})")
            })?;
            save_token(&app, &tok);
            post_chat(&tok.access_token, broadcaster_user_id, text)
                .await
                .map_err(|e| e.to_string())
        }
        Err(other) => Err(other.to_string()),
    }
}

enum SendError {
    Unauthorized,
    Other(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::Unauthorized => write!(f, "unauthorized"),
            SendError::Other(s) => write!(f, "{s}"),
        }
    }
}

async fn post_chat(
    access_token: &str,
    broadcaster_user_id: u64,
    content: &str,
) -> Result<(), SendError> {
    let client = reqwest::Client::new();
    let resp = client
        .post(CHAT_URL)
        .bearer_auth(access_token)
        .json(&serde_json::json!({
            // "user" posts as the authenticated user (vs "bot"). The
            // broadcaster id targets whose channel to post into.
            "type": "user",
            "content": content,
            "broadcaster_user_id": broadcaster_user_id,
        }))
        .send()
        .await
        .map_err(|e| SendError::Other(format!("send request failed: {e}")))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(SendError::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(SendError::Other(format!("Kick API returned {status}: {body}")));
    }
    Ok(())
}

/// Percent-decode (redirect code/state may be URL-encoded). Mirrors
/// oauth.rs's url_decode.
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                    if let Ok(byte) = u8::from_str_radix(hex, 16) {
                        out.push(byte as char);
                        i += 3;
                        continue;
                    }
                }
                out.push('%');
                i += 1;
            }
            b'+' => {
                out.push(' ');
                i += 1;
            }
            c => {
                out.push(c as char);
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_example() {
        // The canonical example from RFC 7636 Appendix B: this exact
        // verifier must produce this exact challenge. Proves our
        // SHA-256 + base64url-nopad pipeline is spec-correct (a wrong
        // challenge means Kick rejects every login at token exchange).
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = b64url_nopad(&sha256(verifier.as_bytes()));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn b64url_has_no_padding_or_plus_slash() {
        let enc = b64url_nopad(&[0xff, 0xff, 0xff, 0xfe]);
        assert!(!enc.contains('='));
        assert!(!enc.contains('+'));
        assert!(!enc.contains('/'));
    }

    #[test]
    fn url_decode_roundtrips_reserved() {
        assert_eq!(url_decode("a%2Bb%20c"), "a+b c");
        assert_eq!(url_decode("plain"), "plain");
    }

    #[test]
    fn random_tokens_are_unique_and_urlsafe() {
        let a = random_token(24);
        let b = random_token(24);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
