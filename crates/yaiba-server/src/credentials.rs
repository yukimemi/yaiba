//! Secrets that belong to the person at this machine, not to a project.
//!
//! `<data dir>/credentials.toml`, beside `projects.toml`. This is the
//! first machine-level file yaiba has had — the registry next to it is
//! an index of databases, not a settings store — so what it is *for* is
//! worth stating rather than leaving to be inferred: things that are
//! true of the human and their machine, and would be wrong to answer
//! differently per project.
//!
//! A Google refresh token is the first of those. It lived in each
//! project's `meta` until #168, which was the right *kind* of store —
//! `entries_since` ships the `crdt` table and nothing else, so `meta`
//! does not replicate, and a credential must not — but `meta` is also
//! per-database, and a project is a database. Choosing the correct
//! non-replicated store silently chose a scope nobody picked, and the
//! bill was a consent screen per project.
//!
//! **A general settings file should not be this file.** The mode below
//! is `0600` because everything in here is a secret; putting a theme
//! preference behind that would be filing a public thing in a private
//! drawer and would make the mode look incidental. If yaiba ever wants
//! machine-level *settings*, they get their own file.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::projects::data_dir;

const CREDENTIALS_FILE: &str = "credentials.toml";

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Credentials {
    /// Google's refresh token for this machine.
    ///
    /// One per person rather than one per project: the same account, the
    /// same OAuth client, the same human. Which *calendar* each project
    /// writes to stays in that project's `meta`, because that genuinely
    /// is a property of the project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcal_refresh_token: Option<String>,
}

/// `<data dir>/credentials.toml`.
pub fn default_path() -> Result<PathBuf> {
    Ok(data_dir()?.join(CREDENTIALS_FILE))
}

pub fn load() -> Result<Credentials> {
    load_from(&default_path()?)
}

/// A missing file is an empty set of credentials — the case on every
/// machine that has not logged in yet.
///
/// A *corrupt* one is an error rather than a silent reset, for the
/// reason the registry gives: overwriting it discards something the
/// person cannot get back without repeating a browser flow, and the fix
/// needs the path.
pub fn load_from(path: &Path) -> Result<Credentials> {
    match std::fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).with_context(|| {
            format!(
                "{} is not valid yaiba credentials TOML; fix or delete it",
                path.display()
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Credentials::default()),
        Err(e) => Err(e).with_context(|| format!("could not read {}", path.display())),
    }
}

pub fn save(credentials: &Credentials) -> Result<()> {
    save_to(&default_path()?, credentials)
}

/// Write via a temporary file and rename, as the registry does, so an
/// interrupted save cannot truncate a good credential into an empty one.
///
/// The mode is set on the temporary file *before* the rename, so the
/// secret is never briefly readable at the final path. On Windows there
/// is no mode to set: the file inherits the ACL of the data directory,
/// which is under the user's profile and so already not world-readable.
/// Tightening it further would mean an explicit ACL rewrite, which is
/// worth doing only if this file ever holds something worse than a token
/// that can be revoked from a web page.
pub fn save_to(path: &Path, credentials: &Credentials) -> Result<()> {
    let dir = path
        .parent()
        .context("the credentials path has no parent directory")?;
    std::fs::create_dir_all(dir).with_context(|| format!("could not create {}", dir.display()))?;

    let text = toml::to_string_pretty(credentials).context("could not serialize credentials")?;
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, text).with_context(|| format!("could not write {}", tmp.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("could not restrict {}", tmp.display()))?;
    }

    std::fs::rename(&tmp, path).with_context(|| format!("could not replace {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        // A path of this process's own, so parallel tests cannot collide
        // and nothing reaches for `YAIBA_DATA_DIR` — `set_var` is
        // `unsafe` in edition 2024 and the environment is shared across
        // the whole test binary.
        std::env::temp_dir().join(format!(
            "yaiba-credentials-{}-{}",
            std::process::id(),
            yaiba_core::model::TaskId::now_v7()
        ))
    }

    #[test]
    fn a_missing_file_is_an_empty_set_rather_than_an_error() {
        let dir = temp();
        let creds =
            load_from(&dir.join(CREDENTIALS_FILE)).expect("a missing file is not a failure");
        assert_eq!(creds.gcal_refresh_token, None);
    }

    #[test]
    fn a_token_survives_a_round_trip() {
        let path = temp().join(CREDENTIALS_FILE);
        save_to(
            &path,
            &Credentials {
                gcal_refresh_token: Some("1//abc".into()),
            },
        )
        .unwrap();
        assert_eq!(
            load_from(&path).unwrap().gcal_refresh_token,
            Some("1//abc".into())
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn an_absent_token_is_left_out_of_the_file_entirely() {
        // Rather than written as an empty string, which reads back as a
        // credential that is present and useless.
        let path = temp().join(CREDENTIALS_FILE);
        save_to(&path, &Credentials::default()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("gcal_refresh_token"),
            "an absent token should not be named at all: {text}"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_corrupt_file_is_reported_rather_than_silently_replaced() {
        let path = temp().join(CREDENTIALS_FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "this is not toml = = =").unwrap();
        let error = load_from(&path).expect_err("garbage should not read as empty");
        assert!(
            format!("{error:#}").contains("fix or delete"),
            "the message should name the way out: {error:#}"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_not_readable_by_anybody_else() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp().join(CREDENTIALS_FILE);
        save_to(
            &path,
            &Credentials {
                gcal_refresh_token: Some("1//abc".into()),
            },
        )
        .unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "mode was {:o}", mode & 0o777);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
