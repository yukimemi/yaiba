//! Handing a URL to whatever the person browses with.
//!
//! Shared rather than owned by startup, because `gcal login` needs the
//! same thing for the consent screen and the alternative is two copies
//! of the same three `cfg` arms.
//!
//! **Every caller prints the URL first.** That is what makes opening a
//! browser safe to attempt at all: over SSH, in a container, or on a
//! headless box there is nothing to open, and a caller that relied on
//! the launch would leave somebody watching a process that looks hung
//! with no way to find the address it wanted them to visit.
//!
//! **On Windows this calls `ShellExecuteW` rather than spawning
//! `cmd /C start`,** and the reason is worth keeping. `start` is a `cmd`
//! builtin whose entire job is to call `ShellExecute`, so going through
//! `cmd` bought nothing and cost two things:
//!
//! - **A parse of the URL by a command interpreter.** `cmd` splits its
//!   command line on `&`, and an OAuth URL is mostly `&`. For as long as
//!   the launcher existed the only URL it was handed was
//!   `http://localhost:8188`, which has none — and the first consent URL
//!   turned everything after `client_id` into commands of its own, so
//!   Google answered "Required parameter is missing: response_type" and
//!   the terminal filled with `'response_type' is not recognized as an
//!   internal or external command`. v0.23.1 fixed that by quoting the
//!   URL; this removes the parse instead, so there is nothing left to
//!   quote, escape, or refuse.
//! - **A `cmd.exe` child of an unsigned binary, carrying the URL on its
//!   command line.** Endpoint security scores process trees, and
//!   "unsigned executable in a user-writable directory launches the
//!   command interpreter with a long external URL" is the shape of a
//!   credential handoff — the more so while the unquoted version had
//!   `cmd` trying to execute `response_type=code` and a base64 PKCE
//!   challenge as commands. It reads as T1218 proxy execution because
//!   structurally that is what it was, and CrowdStrike quarantined a
//!   0.23.0 binary for it. The OAuth parameters also landed in
//!   process-creation telemetry, which is not where a `client_id` and a
//!   PKCE challenge belong.
//!
//! `ShellExecuteW` takes the URL as one opaque argument, so nothing
//! parses it and no process appears between yaiba and the browser.

/// Best-effort browser launch. A failure here is cosmetic — the URL is
/// already on screen — so it warns instead of aborting anything.
pub fn open(url: &str) {
    #[cfg(target_os = "windows")]
    open_windows(url);
    #[cfg(not(target_os = "windows"))]
    open_other(url);
}

/// A NUL-terminated UTF-16 copy, which is what the `W` in `ShellExecuteW`
/// asks for.
#[cfg(target_os = "windows")]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn open_windows(url: &str) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file = wide(url);
    // The default verb for a URL is `open` anyway; naming it says which
    // of a handler's verbs we mean rather than leaving it to whatever is
    // registered first.
    let verb = wide("open");

    // On its own thread, because `ShellExecuteW` is synchronous and sits
    // for as long as a cold browser takes to come up. Both callers are
    // inside an async runtime, and the startup one is the line before
    // `axum::serve` — blocking there would hold the listener shut against
    // the browser it has just opened. `Command::spawn` returned
    // immediately, and this keeps that property.
    std::thread::spawn(move || {
        // SAFETY: both pointers are NUL-terminated UTF-16 buffers that
        // live until the call returns, and `ShellExecuteW` does not
        // retain either. A null `hwnd` means "no owner window", which is
        // what a process with no window of its own has to pass.
        let rc = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        // Documented as an `HINSTANCE` for compatibility and never a real
        // one: anything above 32 is success, anything at or below it is
        // the reason for the failure.
        let code = rc.addr();
        if code <= 32 {
            tracing::warn!(
                "could not open a browser automatically (ShellExecuteW returned {code}); \
                 the URL is on screen to open by hand"
            );
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn open_other(url: &str) {
    // Both take the URL as one argv entry, so — as with `ShellExecuteW`
    // — no shell ever parses it.
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(url).spawn();
    #[cfg(not(target_os = "macos"))]
    let spawned = std::process::Command::new("xdg-open").arg(url).spawn();

    if let Err(e) = spawned {
        tracing::warn!("could not open a browser automatically: {e}");
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    /// The contract that replaced v0.23.1's quoting: the URL reaches the
    /// shell character for character, so no character needs escaping or
    /// refusing any more.
    ///
    /// `&` is the one that broke — `cmd` read it as a command separator.
    /// `"` is the one the quoting fix then had to turn away, because it
    /// would have closed the quotes and handed `cmd` the rest as
    /// commands. Neither means anything to `ShellExecuteW`, and this is
    /// what would fail if somebody reintroduced a quoting step.
    #[test]
    fn the_url_reaches_the_shell_untouched() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth\
                   ?client_id=x&response_type=code&scope=y&state=a\"b";

        let encoded = super::wide(url);

        assert_eq!(
            encoded.last(),
            Some(&0),
            "ShellExecuteW reads until a NUL terminator"
        );
        assert!(
            !encoded[..encoded.len() - 1].contains(&0),
            "an interior NUL would truncate the URL"
        );
        assert_eq!(
            String::from_utf16(&encoded[..encoded.len() - 1]).expect("valid UTF-16"),
            url,
            "nothing may be quoted, escaped or dropped on the way through"
        );
    }
}
