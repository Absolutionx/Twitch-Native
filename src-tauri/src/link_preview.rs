// Link-hover previews for chat URLs. In Rust because a cross-origin webview
// fetch() usually can't read the response body (no CORS headers), while a plain
// reqwest GET has no CORS concept and can. Scans the first chunk of markup with
// a small regex for og:title/description/image rather than pulling in an HTML
// parser for a non-critical feature.

use serde::Serialize;

/// Hard cap on how much of the response body we read. Open Graph/Twitter
/// Card meta tags and <title> are always in <head>, near the top of the
/// document - capping comfortably covers that without ever downloading a
/// multi-megabyte page body just to show a hover preview.
const LINK_PREVIEW_MAX_BYTES: usize = 512 * 1024;

#[derive(Serialize)]
pub struct LinkPreview {
    url: String,
    title: Option<String>,
    description: Option<String>,
    image: Option<String>,
    site_name: Option<String>,
}

/// Fetches `url` and extracts whatever preview metadata it can find
/// (Open Graph tags, falling back to <title>/<meta name="description">).
/// Returns a LinkPreview with all-None fields rather than erroring if the
/// page simply doesn't have any of this - chat.js treats "no useful
/// fields" as "don't bother showing a popup," same as a fetch error.
#[tauri::command]
pub async fn fetch_link_preview(url: String) -> Result<LinkPreview, String> {
    // Only ever fetch http(s) - chat.js's URL regex shouldn't produce
    // anything else, but this is the actual network boundary, so it's the
    // right place to be defensive about what scheme we'll act on.
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Refusing to fetch non-http(s) URL".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        // Several sites - X/Twitter specifically among them - serve
        // fuller (sometimes the ONLY) metadata in <head> to User-Agents
        // they recognize as link-unfurling bots (Discordbot, Twitterbot,
        // facebookexternalhit, Slackbot-LinkExpanding, etc.), and may
        // otherwise serve a JS-rendered app shell with little or nothing
        // useful in the raw HTML. Our previous made-up UA string matched
        // neither "known bot" nor "real browser," which is the leading
        // explanation for why this seemed to work for some posts and not
        // others - mimicking a widely-recognized previewer (Discord's) is
        // the standard fix and is honestly what this code actually is: a
        // link-preview fetcher, not an attempt to impersonate a person.
        .header(
            "User-Agent",
            "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
        )
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("Request failed with status {}", response.status()));
    }

    // Read only up to LINK_PREVIEW_MAX_BYTES rather than the whole body -
    // bytes() on a reqwest Response still has to download everything
    // before returning, so stream chunks instead and stop early once
    // we've got enough to find the <head> metadata.
    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(LINK_PREVIEW_MAX_BYTES.min(64 * 1024));
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk);
        if buf.len() >= LINK_PREVIEW_MAX_BYTES {
            break;
        }
    }

    // Lossy is fine here - we're regex-scanning for ASCII attribute
    // markers; any mangled multi-byte text inside an extracted value is a
    // cosmetic edge case in a hover preview, not worth a hard failure.
    let html = String::from_utf8_lossy(&buf);

    // Open Graph first, falling back to Twitter Card tags (twitter:title
    // etc.) for sites - X/Twitter posts being the motivating case - that
    // don't consistently populate both families on every page. Some posts
    // only set one or the other (this seems to vary per-post rather than
    // site-wide - e.g. sensitive/age-restricted or media-less posts often
    // omit fields that a normal post includes), so checking only og:*
    // meant some posts' previews came back empty even though the page
    // had perfectly good twitter:* tags sitting right next to them.
    let title = extract_meta(&html, "og:title")
        .or_else(|| extract_meta(&html, "twitter:title"))
        .or_else(|| extract_title_tag(&html));
    let description = extract_meta(&html, "og:description")
        .or_else(|| extract_meta(&html, "twitter:description"))
        .or_else(|| extract_meta_name(&html, "description"));
    let image = extract_meta(&html, "og:image")
        .or_else(|| extract_meta(&html, "twitter:image"))
        .or_else(|| extract_meta(&html, "twitter:image:src"));
    let site_name = extract_meta(&html, "og:site_name")
        .or_else(|| extract_meta(&html, "twitter:site"));

    Ok(LinkPreview {
        url,
        title: title.map(|s| decode_html_entities(&s)),
        description: description.map(|s| decode_html_entities(&s)),
        image,
        site_name: site_name.map(|s| decode_html_entities(&s)),
    })
}

/// Finds `<meta property="og:X" content="...">` (or content-then-property
/// order - both appear in the wild) and returns the content value.
/// Deliberately tolerant of attribute order/whitespace/quote style since
/// this is scanning real-world HTML, not a controlled format.
fn extract_meta(html: &str, property: &str) -> Option<String> {
    find_meta_content(html, "property", property)
        .or_else(|| find_meta_content(html, "name", property))
}

fn extract_meta_name(html: &str, name: &str) -> Option<String> {
    find_meta_content(html, "name", name)
}

/// Scans for the first `<meta ...>` tag whose `attr` equals `value`
/// (case-insensitive on the value match for property/name, since e.g.
/// some sites emit "OG:Title"), then pulls that same tag's `content`
/// attribute out, regardless of which attribute came first in the tag.
fn find_meta_content(html: &str, attr: &str, value: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let needle = format!("{attr}=\"{}\"", value.to_ascii_lowercase());
    let needle_alt = format!("{attr}='{}'", value.to_ascii_lowercase());
    let mut search_from = 0;
    while let Some(rel_pos) = lower[search_from..].find(&needle)
        .or_else(|| lower[search_from..].find(&needle_alt))
    {
        let match_pos = search_from + rel_pos;
        // Walk backward to this tag's '<' and forward to its '>' so we
        // only look for `content=` within THIS tag, not some later one.
        let tag_start = lower[..match_pos].rfind('<').unwrap_or(0);
        let tag_end = lower[match_pos..].find('>').map(|i| match_pos + i).unwrap_or(lower.len());
        let tag_slice = &html[tag_start..tag_end.min(html.len())];
        if let Some(content) = extract_attr(tag_slice, "content") {
            if !content.trim().is_empty() {
                return Some(content.trim().to_string());
            }
        }
        // Advance past this tag. byte index '+1' can land mid-codepoint
        // if whatever immediately follows '>' is non-ASCII (e.g. a
        // multi-byte char right after the tag with no space) - to_ascii_-
        // lowercase() preserves byte length/validity, but a slice
        // starting mid-codepoint still panics, so snap forward to the
        // next valid char boundary rather than assuming +1 lands on one.
        let mut next = (tag_end + 1).min(lower.len());
        while next < lower.len() && !lower.is_char_boundary(next) {
            next += 1;
        }
        search_from = next;
        if search_from >= lower.len() {
            break;
        }
    }
    None
}

/// Pulls `attr="value"` or `attr='value'` out of a single tag's raw text.
fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    for (quote, needle) in [('"', format!("{attr}=\"")), ('\'', format!("{attr}='"))] {
        if let Some(start) = lower.find(&needle) {
            let value_start = start + needle.len();
            if let Some(end_rel) = tag[value_start..].find(quote) {
                return Some(tag[value_start..value_start + end_rel].to_string());
            }
        }
    }
    None
}

/// Fallback for pages with no og:title: plain `<title>...</title>`.
fn extract_title_tag(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open_end = lower[start..].find('>')? + start + 1;
    let close = lower[open_end..].find("</title>")? + open_end;
    let text = html[open_end..close].trim();
    if text.is_empty() { None } else { Some(text.to_string()) }
}

/// Minimal entity decoding for the handful of entities that actually show
/// up in titles/descriptions in practice. Not a full HTML entity table -
/// just enough that "Foo &amp; Bar" renders as "Foo & Bar" instead of
/// literally showing the escape sequence in the preview popup.
fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

/// Fetches arbitrary JSON server-side, to work around CORS - added
/// specifically for VOD storyboard (seek-preview thumbnail) metadata,
/// whose CDN (cloudfront.net) doesn't send an Access-Control-Allow-Origin
/// header permitting this app's webview origin (http://tauri.localhost)
/// to read it via a plain fetch() - confirmed via a real browser console
/// error. reqwest has no concept of CORS at all (it isn't a browser), so
/// this sidesteps the restriction the same way the rest of this file's
/// fetch_link_preview does for the same underlying reason.
///
/// Deliberately scoped to https:// only, and named for its actual
/// purpose rather than something broader - this is NOT meant as a
/// general-purpose proxy, even though nothing technically stops the
/// frontend from passing any URL through it. That's an acceptable
/// tradeoff here specifically because this is a desktop app where
/// whoever can edit the frontend to call this already has the same
/// level of access as this Rust backend itself - there's no separate
/// "untrusted caller" this needs to defend against the way a hosted
/// service would.
#[tauri::command]
pub async fn fetch_storyboard_json(url: String) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("Refusing to fetch non-https URL".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(&url)
        // Twitch's storyboard CDN (cloudfront.net) has been observed
        // returning 403 Forbidden without this - a real yt-dlp GitHub
        // issue reported the exact same failure for this exact same
        // endpoint, suggesting it checks Referer and rejects requests
        // that don't look like they came from twitch.tv itself.
        .header("Referer", "https://www.twitch.tv/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Request failed with status {}", response.status()));
    }
    response.text().await.map_err(|e| e.to_string())
}
