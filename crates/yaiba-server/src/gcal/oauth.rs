//! Getting and keeping a Google credential.
//!
//! The installed-app flow: yaiba binds a loopback port, sends the person
//! to Google with that port as the redirect, and reads the code back off
//! its own socket. There is no hosted callback because there is no host
//! — the same reason the rest of yaiba has none.
//!
//! **The refresh token lives in `meta`, not in the CRDT.** `entries_since`
//! ships the `crdt` table and nothing else, so a credential written to
//! `meta` stays on the replica that earned it. That is not a tidiness
//! argument: a token in the log would replicate to every peer in the
//! room, which for a shared project means handing your calendar to
//! everyone you plan with. `meta` is where `sync_secret_key` already
//! lives for the same reason.
//!
//! It also means the mapping is per-replica by construction, which is
//! the behaviour that makes sense anyway — each person syncs their own
//! tasks into their own calendar, and the derived event ids in the
//! parent module make two replicas that *do* share a calendar converge
//! rather than duplicate.
//!
//! ## The seven-day trap
//!
//! A Cloud project left at publishing status "Testing" is issued
//! refresh tokens that expire in seven days, which is documented and is
//! the single most likely reason for this to appear broken later. So the
//! error raised when a refresh is rejected names it, rather than saying
//! only that the token is invalid — a person who has to *discover* that
//! rule has already spent an evening on it.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use yaiba_core::model::TaskId;

/// Where the consent screen lives.
const AUTH_URI: &str = "https://accounts.google.com/o/oauth2/v2/auth";
/// Where a code and a refresh token are exchanged.
const TOKEN_URI: &str = "https://oauth2.googleapis.com/token";

/// Full calendar access, rather than the narrower `calendar.events`.
///
/// Google's advice is the narrowest scope that works, and `calendar.events`
/// would cover every write this feature makes *to* events. What it cannot
/// do is create a calendar, and the dedicated `yaiba: <project>` calendar
/// is what makes the whole integration removable in one gesture — a
/// person who wants their plan off their calendar deletes the calendar,
/// rather than trusting yaiba to tidy up after itself.
const SCOPE: &str = "https://www.googleapis.com/auth/calendar";

/// The `meta` key the refresh token is filed under.
const KEY_REFRESH: &str = "gcal_refresh_token";
/// The `meta` key holding the calendar this project writes to.
pub const KEY_CALENDAR: &str = "gcal_calendar_id";

/// How long to wait for somebody to finish consenting.
const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);

/// The client this yaiba presents itself as.
///
/// Brought in by the operator rather than baked into the binary. Which
/// of the two it should be is [#162], and the decision is deliberately
/// confined to this function: a bundled pair changes these six lines and
/// nothing downstream, because every caller works in refresh tokens.
///
/// [#162]: https://github.com/yukimemi/yaiba/issues/162
pub struct Credentials {
    pub id: String,
    pub secret: String,
}

impl Credentials {
    pub fn from_env() -> Result<Self> {
        let id = std::env::var("YAIBA_GCAL_CLIENT_ID")
            .ok()
            .filter(|v| !v.is_empty());
        let secret = std::env::var("YAIBA_GCAL_CLIENT_SECRET")
            .ok()
            .filter(|v| !v.is_empty());
        match (id, secret) {
            (Some(id), Some(secret)) => Ok(Self { id, secret }),
            _ => bail!(
                "set YAIBA_GCAL_CLIENT_ID and YAIBA_GCAL_CLIENT_SECRET to an OAuth client of \
                 type \"Desktop app\". Create one at https://console.cloud.google.com/apis/credentials \
                 in a project with the Google Calendar API enabled, and publish its consent \
                 screen to production — a project left in \"Testing\" issues refresh tokens \
                 that expire after seven days"
            ),
        }
    }
}

/// An access token and the moment it stops being one.
pub struct Access {
    pub token: String,
    expires_at: u64,
}

impl Access {
    pub fn valid(&self) -> bool {
        // A minute of slack: a token that expires mid-reconcile fails a
        // write half way through a run, which is the one failure this
        // whole module is arranged to avoid.
        now() + 60 < self.expires_at
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
}

/// The URL-safe base64 of the SHA-256 of the verifier, unpadded — the
/// `S256` code challenge exactly as RFC 7636 spells it.
fn challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/// A PKCE verifier, and the `state` that goes with it.
///
/// Two v4 UUIDs joined by a hyphen: 73 characters drawn from the
/// unreserved set, comfortably inside RFC 7636's 43–128, and randomness
/// this crate already has rather than a dependency taken for one string.
fn nonce() -> String {
    format!("{}-{}", TaskId::new_v4(), TaskId::new_v4())
}

/// Percent-encode the characters that would otherwise end a query value.
///
/// Deliberately not a general encoder: everything put through it here is
/// a URL, a scope or a nonce, so the reserved set is small and known. A
/// general one would be a dependency, and a wrong general one is worse
/// than a narrow right one.
fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(char::from(byte))
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Undo the percent-encoding on one query value.
///
/// The redirect is a URL, so a value in it may be encoded and has to be
/// decoded before it means anything — an authorisation code handed
/// onwards still wearing its `%2F` gets form-encoded a second time and
/// reaches Google as `%252F`, which comes back as `invalid_grant` with a
/// message about publishing status that has nothing to do with it.
///
/// In practice Google leaves the `/` in a code alone, because `/` is
/// legal in a query and needs no encoding — which is why the flow worked
/// before this existed. That is a property of what Google currently
/// sends, not of what a URL is allowed to contain, and it is not one to
/// keep depending on.
///
/// `+` is deliberately *not* read as a space. That convention belongs to
/// form bodies; the two values this ever sees are an authorisation code
/// and a nonce this process minted, and rewriting a literal `+` in
/// either of them would corrupt the thing being decoded.
fn unescape(value: &str) -> String {
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    let raw = value.as_bytes();
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        match (raw[i], raw.get(i + 1).copied(), raw.get(i + 2).copied()) {
            (b'%', Some(hi), Some(lo)) => match (nibble(hi), nibble(lo)) {
                (Some(hi), Some(lo)) => {
                    out.push((hi << 4) | lo);
                    i += 3;
                }
                // A stray `%` that is not an escape stays a `%`, which
                // is what every browser does with one.
                _ => {
                    out.push(raw[i]);
                    i += 1;
                }
            },
            _ => {
                out.push(raw[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Run the consent flow and return a refresh token.
///
/// Prints the URL rather than opening a browser. Opening one is a
/// dependency and a guess — over SSH, in a container, or on a headless
/// box the guess is wrong and the person is left watching a process that
/// looks hung, with the URL it wanted them to visit never shown.
pub async fn consent(creds: &Credentials) -> Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("could not bind a loopback port for the OAuth redirect")?;
    let port = listener.local_addr()?.port();
    let redirect = format!("http://127.0.0.1:{port}");

    let verifier = nonce();
    let state = nonce();
    let url = format!(
        "{AUTH_URI}?client_id={}&redirect_uri={}&response_type=code&scope={}\
         &code_challenge={}&code_challenge_method=S256&state={}\
         &access_type=offline&prompt=consent",
        escape(&creds.id),
        escape(&redirect),
        escape(SCOPE),
        escape(&challenge(&verifier)),
        escape(&state),
    );

    println!("\nOpen this and grant yaiba access to your calendar:\n\n  {url}\n");
    println!(
        "Google will warn that the app is unverified — that is expected for a client you \
         created yourself. Choose \"Advanced\", then \"Go to ... (unsafe)\".\n"
    );

    let code = tokio::time::timeout(CONSENT_TIMEOUT, redirected_code(&listener, &state))
        .await
        .context("nobody finished the consent screen within five minutes")??;

    let response = exchange(
        creds,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect),
            ("code_verifier", &verifier),
        ],
    )
    .await?;

    // `access_type=offline` with `prompt=consent` is what makes Google
    // issue one. Without the prompt it is returned on the *first* grant
    // only, so a second run against an already-authorised account
    // silently yields none — which is why the prompt is not optional
    // here even though it costs a click.
    response
        .refresh_token
        .context("Google returned no refresh token, so nothing could be stored to reuse")
}

/// Read the redirect off the loopback socket and answer the browser.
async fn redirected_code(listener: &TcpListener, state: &str) -> Result<String> {
    loop {
        let (stream, _) = listener.accept().await?;
        if let Some(code) = handle_redirect(stream, state).await? {
            return Ok(code);
        }
        // Browsers ask for /favicon.ico on the same origin. Answering it
        // and going back to waiting is the difference between a flow that
        // works and one that fails on whichever browser asks first.
    }
}

async fn handle_redirect(mut stream: TcpStream, state: &str) -> Result<Option<String>> {
    let mut request = String::new();
    BufReader::new(&mut stream).read_line(&mut request).await?;

    let target = request.split_whitespace().nth(1).unwrap_or_default();
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or_default();
    let mut code = None;
    let mut echoed = None;
    let mut error = None;
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("code", value)) => code = Some(unescape(value)),
            Some(("state", value)) => echoed = Some(unescape(value)),
            Some(("error", value)) => error = Some(unescape(value)),
            _ => {}
        }
    }

    let body = if let Some(error) = &error {
        format!("yaiba: Google refused the request ({error}). You can close this tab.")
    } else if code.is_some() {
        "yaiba has what it needs. You can close this tab.".to_string()
    } else {
        // Not the redirect — a favicon probe, or somebody's browser
        // being curious. Say nothing useful and keep listening.
        "yaiba is waiting for the consent redirect.".to_string()
    };
    let _ = stream
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await;
    let _ = stream.shutdown().await;

    if let Some(error) = error {
        bail!("Google refused the consent request: {error}");
    }
    match code {
        None => Ok(None),
        // A redirect carrying the wrong `state` is not this flow's, so
        // the code in it is not this flow's either. Refusing rather than
        // ignoring: something reached a port only this run knows about.
        Some(_) if echoed.as_deref() != Some(state) => {
            bail!("the OAuth redirect carried a state this run did not issue")
        }
        Some(code) => Ok(Some(code)),
    }
}

/// Trade a refresh token for an access token.
pub async fn refresh(creds: &Credentials, refresh_token: &str) -> Result<Access> {
    let response = exchange(
        creds,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ],
    )
    .await?;
    Ok(Access {
        token: response.access_token,
        // Google sends one; the fallback is its documented hour rather
        // than an optimistic forever.
        expires_at: now() + response.expires_in.unwrap_or(3600),
    })
}

async fn exchange(creds: &Credentials, form: &[(&str, &str)]) -> Result<TokenResponse> {
    let mut params: Vec<(&str, &str)> = form.to_vec();
    params.push(("client_id", &creds.id));
    params.push(("client_secret", &creds.secret));

    let response = super::http()
        .post(TOKEN_URI)
        .form(&params)
        .send()
        .await
        .context("could not reach Google's token endpoint")?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        // `invalid_grant` is the one everybody meets, and on its own it
        // says nothing about which of its several causes applied. The
        // seven-day rule is by far the most likely and the least
        // guessable, so it is named here rather than left to be found.
        if body.contains("invalid_grant") {
            bail!(
                "Google rejected the stored credential ({status}). The usual cause is a Cloud \
                 project still at publishing status \"Testing\", which expires refresh tokens \
                 after seven days — publish the consent screen to production and run \
                 `yaiba gcal login` again. Access being revoked, or the client id changing, \
                 look the same from here.\n{body}"
            );
        }
        bail!("Google's token endpoint answered {status}: {body}");
    }
    serde_json::from_str(&body).context("Google's token response was not the shape expected")
}

/// The refresh token this project has stored, if it has one.
///
/// Both of these speak the store's own error type rather than
/// `anyhow`'s, so a handler can `?` them beside every other store call.
/// They are store operations that happen to be about a credential, not
/// network ones.
pub fn stored(store: &yaiba_core::store::Store) -> yaiba_core::Result<Option<String>> {
    Ok(store.meta(KEY_REFRESH)?.filter(|t| !t.is_empty()))
}

/// File a refresh token against this project.
pub fn store(store: &yaiba_core::store::Store, token: &str) -> yaiba_core::Result<()> {
    store.set_meta(KEY_REFRESH, token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_is_the_one_rfc_7636_gives_as_an_example() {
        // RFC 7636 appendix B, so this pins the encoding against
        // somebody else's arithmetic rather than against our own.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn a_verifier_is_long_enough_and_uses_only_unreserved_characters() {
        let verifier = nonce();
        assert!(
            (43..=128).contains(&verifier.len()),
            "{} is outside RFC 7636's range",
            verifier.len()
        );
        assert!(
            verifier
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~')),
            "{verifier} leaves the unreserved set"
        );
        assert_ne!(nonce(), nonce(), "a nonce that repeats is not one");
    }

    #[test]
    fn escaping_leaves_the_unreserved_set_alone_and_encodes_the_rest() {
        assert_eq!(escape("aZ0-._~"), "aZ0-._~");
        assert_eq!(
            escape("http://127.0.0.1:8188"),
            "http%3A%2F%2F127.0.0.1%3A8188"
        );
        assert_eq!(
            escape("https://www.googleapis.com/auth/calendar"),
            "https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar"
        );
    }

    #[test]
    fn a_redirect_value_is_decoded_before_it_is_used() {
        // The failure this prevents is not a crash: the code reaches
        // Google double-encoded, comes back `invalid_grant`, and the
        // handler blames the seven-day publishing rule.
        assert_eq!(unescape("4%2F0AVMBsJj-x_y"), "4/0AVMBsJj-x_y");
        assert_eq!(unescape("access%5Fdenied"), "access_denied");
        assert_eq!(unescape("%e5%88%83"), "刃");
        // Lower and upper hex both, since nothing says which Google uses.
        assert_eq!(unescape("%2f%2F"), "//");
    }

    #[test]
    fn a_value_that_needs_no_decoding_survives_it_untouched() {
        // Google leaves `/` alone today — it is legal in a query — which
        // is why the flow worked before the decoder existed. Decoding
        // must therefore be a no-op on what actually arrives.
        assert_eq!(unescape("4/0AVMBsJj-x_y"), "4/0AVMBsJj-x_y");
        // The `state` this process minted comes back through the same
        // path, and it is compared byte for byte — a decoder that
        // touched it would fail every consent.
        let state = nonce();
        assert_eq!(unescape(&state), state);
        // A stray percent is not an escape and stays put.
        assert_eq!(unescape("100%"), "100%");
        assert_eq!(unescape("%zz"), "%zz");
        // And `+` is left alone rather than read as a space.
        assert_eq!(unescape("a+b"), "a+b");
    }

    #[test]
    fn an_access_token_is_spent_before_it_actually_expires() {
        // The slack is the point: a token good for another 30 seconds is
        // not good enough to start a reconcile with.
        assert!(
            !Access {
                token: String::new(),
                expires_at: now() + 30
            }
            .valid()
        );
        assert!(
            Access {
                token: String::new(),
                expires_at: now() + 600
            }
            .valid()
        );
    }
}
