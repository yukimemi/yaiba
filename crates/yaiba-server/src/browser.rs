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

/// Best-effort browser launch. A failure here is cosmetic — the URL is
/// already on screen — so it warns instead of aborting anything.
pub fn open(url: &str) {
    #[cfg(target_os = "windows")]
    // The empty string is `start`'s title argument; without it a quoted
    // URL would be consumed as the window title and nothing opens.
    let spawned = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(url).spawn();

    if let Err(e) = spawned {
        tracing::warn!("could not open a browser automatically: {e}");
    }
}
