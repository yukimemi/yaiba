//! Background self-update, built on [`kaishin`].
//!
//! `yaiba` defaults to opt-out silent install: on launch it quietly asks
//! GitHub whether a newer release exists and, if so, downloads and swaps
//! its own binary in the background. The running process keeps using the
//! old binary — the new one applies on the next launch — so an update can
//! never pull the floor out from under an open UI.
//!
//! Mode comes from `--update off|notify|install` (env `YAIBA_UPDATE`),
//! and `YAIBA_NO_AUTOUPDATE` force-disables it regardless. Because the
//! server may run for days and never exit cleanly, this uses the
//! fire-and-forget spawn rather than a "finalize before exit" hook, and
//! every failure — network, lock, corrupt state file — stays silent.

use std::path::PathBuf;

use clap::ValueEnum;

const BIN_NAME: &str = "yaiba";
const OWNER: &str = "yukimemi";
const REPO: &str = "yaiba";

/// What to do when a newer release exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, ValueEnum)]
#[value(rename_all = "lower")]
pub enum UpdateMode {
    /// Never contact GitHub.
    Off,
    /// Print a banner, but leave the binary alone.
    Notify,
    /// Download and swap the binary in the background.
    #[default]
    Install,
}

/// Describes this binary to kaishin.
pub fn options() -> kaishin::KaishinOptions {
    kaishin::KaishinOptions::new(OWNER, REPO, BIN_NAME, env!("CARGO_PKG_VERSION"))
}

/// `<cache dir>/yaiba/last_update_check.json`.
///
/// This is throttle state — safe to delete, regenerated on demand — so
/// it belongs in the OS cache directory rather than next to the task
/// database in the data directory, which is the user's actual content.
/// `None` falls back to kaishin's own default rather than failing.
fn state_path() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join(BIN_NAME).join("last_update_check.json"))
}

fn checker() -> kaishin::Checker {
    let mut checker = kaishin::Checker::new(BIN_NAME, options());
    if let Some(path) = state_path() {
        checker = checker.state_path(path);
    }
    checker
}

/// True when the user has opted out via the environment.
fn disabled_by_env() -> bool {
    std::env::var_os("YAIBA_NO_AUTOUPDATE").is_some_and(|v| !v.is_empty())
}

/// Run the interactive `yaiba self-update` flow.
pub async fn run_self_update(
    yes: bool,
    check_only: bool,
    non_interactive: bool,
) -> anyhow::Result<()> {
    let opts = kaishin::UpdateOptions::new()
        .yes(yes)
        .check_only(check_only)
        .non_interactive(non_interactive);
    kaishin::run_self_update(&options(), opts).await
}

/// Start the background check for the long-running server.
///
/// Fire-and-forget: the server has no reliable exit hook to finalize
/// against, and a check that never finishes must not hold up startup.
pub fn spawn(mode: UpdateMode) {
    if disabled_by_env() {
        return;
    }
    match mode {
        UpdateMode::Off => {}
        UpdateMode::Notify => {
            let checker = checker();
            tokio::spawn(async move {
                // Any failure here is invisible on purpose: a background
                // update check has no business interrupting a todo app.
                if let Ok(Some(latest)) = checker.check_and_save().await {
                    eprintln!("\n{}", checker.format_banner(&latest));
                }
            });
        }
        UpdateMode::Install => checker().spawn_auto_update(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_describe_this_binary() {
        let opts = options();
        assert_eq!(opts.owner, "yukimemi");
        assert_eq!(opts.repo, "yaiba");
        assert_eq!(opts.bin_name, "yaiba");
        assert_eq!(opts.current_version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn throttle_state_lives_under_the_cache_dir() {
        // It must not land next to the task database: that directory is
        // the user's data, and this file is disposable.
        if let (Some(path), Some(cache)) = (state_path(), dirs::cache_dir()) {
            assert!(path.starts_with(&cache), "{path:?} not under {cache:?}");
            assert!(path.ends_with("last_update_check.json"));
        }
    }

    #[test]
    fn install_is_the_default_mode() {
        assert_eq!(UpdateMode::default(), UpdateMode::Install);
    }
}
