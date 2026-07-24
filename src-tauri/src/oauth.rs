// Twitch OAuth – browser-based implicit grant flow.
//
// WHY NOT A TAURI WEBVIEW POPUP?
// Previous versions opened a second Tauri WebviewWindow pointed at
// https://id.twitch.tv/oauth2/authorize. Two fatal problems on
// Windows/WebView2:
//   1. Tauri's app-level CSP (default-src 'self'; …) applies to every
//      WebView2 instance it controls, including that popup. Twitch's
//      login page loads scripts/fonts/images from CDNs outside 'self',
//      so they all get blocked → blank page.
//   2. The global on_window_event handler calls api.prevent_close() for
//      every window, so the popup's ✕ button is permanently broken.
//
// THE FIX: RFC 8252 native-app OAuth via the system default browser.
//   1. Spawn a tiny tokio TCP server on 127.0.0.1:17543.
//   2. Open the Twitch auth URL in the user's real browser via the
//      opener plugin - no CSP restrictions there, so login renders fine.
//   3. After login, Twitch redirects to
//      http://localhost:17543/#access_token=… The server serves a
//      one-shot HTML bridge page.
//   4. The bridge page JS reads location.hash (fragments never reach the
//      server directly, hence the bridge page), extracts the token, and
//      GETs /token?t=<token>.
//   5. The server receives the token, emits "oauth-token" to the main
//      Tauri window, and shuts down.
//   6. The bridge page tells the user they can close the tab.
//
// Port 17543 is registered as an allowed redirect URI in the Twitch
// developer console: http://localhost:17543 - if that port is busy on a
// specific machine, change it here AND at
// https://dev.twitch.tv/console/apps.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

const TOKEN_FILE: &str = "oauth_token.json";

#[derive(Serialize, Deserialize)]
struct PersistedToken {
    access_token: String,
}

pub fn save_token(app: &AppHandle, access_token: &str) {
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    let path = dir.join(TOKEN_FILE);
    if let Ok(json) = serde_json::to_string(&PersistedToken {
        access_token: access_token.to_string(),
    }) {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&path, json);
    }
}

pub fn load_token(app: &AppHandle) -> Option<String> {
    let dir = app.path().app_local_data_dir().ok()?;
    let json = std::fs::read_to_string(dir.join(TOKEN_FILE)).ok()?;
    let persisted: PersistedToken = serde_json::from_str(&json).ok()?;
    Some(persisted.access_token)
}

pub fn clear_token(app: &AppHandle) {
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    let _ = std::fs::remove_file(dir.join(TOKEN_FILE));
}

// ---------------------------------------------------------------------------
// OAuth constants
// ---------------------------------------------------------------------------

// This app's Client-ID, registered at https://dev.twitch.tv/console/apps.
// OAuth client IDs (unlike client *secrets*) are public identifiers by
// design in the native-app/implicit-grant flow used here — there is no
// client secret anywhere in this codebase, intentionally, since a secret
// embedded in a distributed desktop binary couldn't be kept secret anyway.
// Safe to keep in source control; see the flow description above.
pub const CLIENT_ID: &str = "i2tkeryeipoljcoh8sjtxtcfd43guv";
const REDIRECT_URI: &str = "http://localhost:17543";
const REDIRECT_PORT: &str = "17543";

#[derive(Serialize, Clone)]
pub struct OAuthTokenEvent {
    pub access_token: String,
}

#[derive(Deserialize, Debug)]
struct ValidateResponse {
    login: String,
    user_id: String,
    #[allow(dead_code)]
    scopes: Vec<String>,
}

// ---------------------------------------------------------------------------
// Login command
// ---------------------------------------------------------------------------

/// Opens the Twitch login page in the user's default browser and starts a
/// local HTTP server to catch the OAuth redirect. Once the token arrives the
/// server emits "oauth-token" to the main window and shuts down.
#[tauri::command]
pub async fn start_oauth_login(app: AppHandle) -> Result<(), String> {
    let scope = [
        "chat:read",
        "chat:edit",
        "channel:read:redemptions",
        "user:read:follows",
        "moderator:manage:banned_users",
        "moderator:manage:chat_messages",
        "moderator:manage:automod",
        "moderator:read:chatters",
    ]
    .join(" ");

    let auth_url = format!(
        "https://id.twitch.tv/oauth2/authorize\
         ?response_type=token\
         &client_id={}\
         &redirect_uri={}\
         &scope={}",
        CLIENT_ID,
        urlencoding_lite(REDIRECT_URI),
        urlencoding_lite(&scope),
    );

    // Try to bind the port before opening the browser. If the port is already
    // in use a previous login attempt is still running - just open the URL
    // again so the user can retry without restarting the app.
    let listener = match TcpListener::bind(format!("127.0.0.1:{REDIRECT_PORT}")).await {
        Ok(l) => l,
        Err(_) => {
            // Port busy — open the URL anyway so the user sees the browser
            // prompt, but don't spawn a second server.
            open_browser(&app, &auth_url)?;
            return Ok(());
        }
    };

    // Spawn the redirect-catcher; open the browser in parallel.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        // 5-minute timeout in case the user abandons the flow.
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

// ---------------------------------------------------------------------------
// Local redirect server
// ---------------------------------------------------------------------------

/// Bridge HTML served to the browser when it reaches http://localhost:17543.
/// The JS reads location.hash (fragments aren't sent to the server by the
/// browser, which is why the implicit grant spec requires this extra hop),
/// pulls out the access_token, and GETs /token?t=<token> so the server can
/// pick it up. Styled to match the app's dark theme.
const BRIDGE_HTML: &str = r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Twitch Native — Logging in</title>
  <style>
    body {
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #0e0e10;
      font-family: Inter, system-ui, sans-serif;
      color: #efeff1;
    }
    .card {
      text-align: center;
      padding: 40px;
      border-radius: 10px;
      background: #1f1f23;
      border: 1px solid #3a3a3d;
      max-width: 360px;
    }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p  { font-size: 14px; color: #adadb8; margin: 0; }
    .ok  { color: #00b341; }
    .err { color: #e91916; }
  </style>
</head>
<body>
<div class="card" id="card">
  <h1>Completing login…</h1>
  <p>One moment please.</p>
</div>
<script>
(function () {
  var hash = location.hash.substring(1);
  var params = new URLSearchParams(hash);
  var token = params.get('access_token');
  var card = document.getElementById('card');

  function show(title, body, cls) {
    card.innerHTML =
      '<h1 class="' + cls + '">' + title + '</h1>' +
      '<p>' + body + '</p>';
  }

  if (!token) {
    show('Login cancelled', 'No token received. You can close this tab.', 'err');
    return;
  }

  fetch('/token?t=' + encodeURIComponent(token))
    .then(function (r) {
      if (r.ok) {
        show('Login successful!',
             'You can close this tab and return to Twitch Native.', 'ok');
      } else {
        show('Something went wrong', 'Please try logging in again.', 'err');
      }
    })
    .catch(function () {
      show('Something went wrong', 'Please try logging in again.', 'err');
    });
})();
</script>
</body>
</html>"#;

async fn run_redirect_server(listener: TcpListener, app: AppHandle) {
    loop {
        let (mut socket, _) = match listener.accept().await {
            Ok(s) => s,
            Err(_) => break,
        };

        // Read enough of the request to identify it.
        let mut buf = vec![0u8; 4096];
        let n = socket.read(&mut buf).await.unwrap_or(0);
        if n == 0 {
            continue;
        }
        let request = String::from_utf8_lossy(&buf[..n]);
        let first_line = request.lines().next().unwrap_or("");

        if first_line.contains("GET /token?") {
            // Bridge page is handing us the token.
            if let Some(token) = extract_token_from_line(first_line) {
                let _ = app.emit("oauth-token", OAuthTokenEvent { access_token: token });
            }
            let resp = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK";
            let _ = socket.write_all(resp).await;
            break; // Done — shut down the server.
        } else if first_line.starts_with("GET /") {
            // Probably the initial Twitch redirect — serve the bridge page.
            // (Ignore favicon.ico, etc.)
            if !first_line.contains("favicon") {
                let body = BRIDGE_HTML.as_bytes();
                let header = format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Type: text/html; charset=utf-8\r\n\
                     Content-Length: {}\r\n\
                     Connection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(header.as_bytes()).await;
                let _ = socket.write_all(body).await;
            }
        }
        // Any other request (favicon, etc.) just drops the connection.
    }
}

/// Extracts the token value from a GET request line like:
/// `GET /token?t=abc123&... HTTP/1.1`
fn extract_token_from_line(line: &str) -> Option<String> {
    let path = line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    for param in query.split('&') {
        if let Some(encoded) = param.strip_prefix("t=") {
            return Some(url_decode(encoded));
        }
    }
    None
}

/// Percent-decode a URL-encoded string (for the token passed from the bridge).
fn url_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte as char);
                    i += 3;
                    continue;
                }
            }
        } else if bytes[i] == b'+' {
            out.push(' ');
            i += 1;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

// ---------------------------------------------------------------------------
// Minimal URL encoding (unchanged from before)
// ---------------------------------------------------------------------------

fn urlencoding_lite(input: &str) -> String {
    input
        .replace(' ', "%20")
        .replace(':', "%3A")
        .replace('/', "%2F")
}

// ---------------------------------------------------------------------------
// Token validation & session restore (unchanged)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn validate_oauth_token(
    app: AppHandle,
    access_token: String,
) -> Result<serde_json::Value, String> {
    let body = reqwest_lite_get(
        "https://id.twitch.tv/oauth2/validate",
        &[("Authorization", &format!("OAuth {access_token}"))],
    )
    .await?;

    let parsed: ValidateResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse validate response: {e}"))?;

    save_token(&app, &access_token);

    Ok(serde_json::json!({ "login": parsed.login, "user_id": parsed.user_id }))
}

#[tauri::command]
pub fn logout(app: AppHandle) {
    clear_token(&app);
}

#[tauri::command]
pub async fn restore_session(app: AppHandle) -> Result<serde_json::Value, String> {
    let Some(token) = load_token(&app) else {
        return Ok(serde_json::Value::Null);
    };

    match reqwest_lite_get(
        "https://id.twitch.tv/oauth2/validate",
        &[("Authorization", &format!("OAuth {token}"))],
    )
    .await
    {
        Ok(body) => match serde_json::from_str::<ValidateResponse>(&body) {
            Ok(parsed) => Ok(serde_json::json!({
                "access_token": token,
                "login": parsed.login,
                "user_id": parsed.user_id
            })),
            Err(e) => {
                clear_token(&app);
                Err(format!("Failed to parse validate response: {e}"))
            }
        },
        Err(_) => {
            clear_token(&app);
            Ok(serde_json::Value::Null)
        }
    }
}

async fn reqwest_lite_get(url: &str, headers: &[(&str, &str)]) -> Result<String, String> {
    let client = reqwest::Client::new();
    let mut request = client.get(url);
    for (key, value) in headers {
        request = request.header(*key, *value);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Request failed with status {}", response.status()));
    }
    response.text().await.map_err(|e| e.to_string())
}
