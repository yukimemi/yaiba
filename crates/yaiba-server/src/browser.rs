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
//! with no way to find the address it wanted them to visit. It is also
//! what made the bug below recoverable rather than fatal.

/// The command line handed to `cmd`, built in one place so the test and
/// the launch cannot drift into disagreeing about the quoting.
#[cfg(target_os = "windows")]
fn windows_command_line(url: &str) -> String {
    format!("/C start \"\" \"{url}\"")
}

/// Best-effort browser launch. A failure here is cosmetic — the URL is
/// already on screen — so it warns instead of aborting anything.
pub fn open(url: &str) {
    // A quote would end the quoting below and hand the rest of the URL
    // to `cmd` as commands. Nothing yaiba builds contains one, since
    // every query value goes through `gcal::escape` first, so this is a
    // refusal rather than an escaping problem: print-only is a perfectly
    // good outcome and inventing an escape for a case that cannot happen
    // is how the case starts happening.
    if url.contains('"') {
        tracing::warn!("not opening a URL containing a quote; it is on screen to open by hand");
        return;
    }

    #[cfg(target_os = "windows")]
    let spawned = {
        use std::os::windows::process::CommandExt;
        // **`cmd` splits its command line on `&`, and an OAuth URL is
        // mostly `&`.** This ran for a year against `http://localhost:8188`
        // — no `&`, no problem — and broke the moment `gcal login` handed
        // it a consent URL: `cmd` took everything after the first `&` as
        // separate commands, so Google received only `client_id` and
        // answered "Required parameter is missing: response_type", and
        // the terminal filled with `'response_type' is not recognized as
        // an internal or external command`.
        //
        // Quoting the URL fixes it, and the quotes have to go in the raw
        // command line: `Command::arg` quotes an argument only when it
        // contains a space or a quote, and a URL has neither, so it
        // arrived bare no matter how it was passed. `raw_arg` is the way
        // to say what the command line actually is.
        //
        // The empty `""` before it is `start`'s window-title argument.
        // Without it `start` takes the quoted URL as the title and opens
        // nothing at all.
        let mut command = std::process::Command::new("cmd");
        command.raw_arg(windows_command_line(url));
        command.spawn()
    };
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(url).spawn();

    if let Err(e) = spawned {
        tracing::warn!("could not open a browser automatically: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn an_oauth_url_is_quoted_so_cmd_cannot_split_it_on_ampersands() {
        let url =
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code&scope=y";
        let line = windows_command_line(url);
        assert!(
            line.ends_with(&format!("\"{url}\"")),
            "the URL must be quoted as one argument: {line}"
        );
        // The failure this reproduces: everything after the first `&`
        // reaching `cmd` as a command of its own.
        assert!(
            line.contains("&response_type=code"),
            "the query must survive intact: {line}"
        );
        assert!(
            line.starts_with("/C start \"\" "),
            "the empty title argument must come first, or `start` takes \
             the URL as the window title: {line}"
        );
    }

    #[test]
    fn a_url_carrying_a_quote_is_left_for_the_person_to_open() {
        // Not a test of the launch — a test that there is no launch. A
        // quote would close the quoting and turn the rest into commands,
        // and the URL is on screen either way.
        super::open("https://example.com/?a=\"&b=c");
    }
}
