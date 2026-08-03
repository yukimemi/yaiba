//! The workspace's own crates are pinned at the version the workspace is.
//!
//! All three members are published, so the `path` dependencies between
//! them carry a `version` as well — crates.io has to be able to resolve
//! the requirement for somebody who is not building from this checkout.
//! That version is a literal, and nothing in Cargo makes it follow
//! `[workspace.package] version` when a release bumps it.
//!
//! Left alone it goes stale silently. `version = "0.16.0"` means
//! `^0.16.0`, so every patch release keeps satisfying a pin nobody has
//! touched, and the build stays green for as long as the minor does not
//! move. Then one release bumps the minor and `cargo build` stops with
//! "candidate versions found which didn't match" — which is what v0.17.0
//! did here, three releases after the pins were last correct.
//!
//! So it is asserted rather than remembered. A test rather than a script
//! because `cargo test` already runs in `cargo make check` and in CI.
//!
//! **It parses the manifests rather than searching them**, and that is
//! not fastidiousness. The first version of this file asked
//! `text.contains("version.workspace")`, which is satisfied by the
//! `rust-version.workspace = true` every member already carries — so a
//! member could hardcode `version = "9.9.9"` and this test passed.
//! Verified, on the crate nothing depends on: on the others cargo
//! refuses to resolve and hides the hole. A test with a false negative
//! is worse than no test, because it is also a claim.
//!
//! `kanade` runs the same code for the same reason — both repos come
//! from `pj-presets:rust-workspace`, and the shape is the preset's, not
//! either repo's.

use std::fs;
use std::path::{Path, PathBuf};

use toml::{Table, Value};

fn workspace_root() -> PathBuf {
    // `CARGO_MANIFEST_DIR` is `crates/<name>`, so the root is two up.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crates/<name> always has two ancestors")
        .to_path_buf()
}

/// A whole manifest.
///
/// `Table`, not `Value`: parsing into `Value` reads a single TOML
/// *value*, so a document starting `[workspace]` comes back as a failed
/// array rather than as the file.
fn manifest(path: &Path) -> Table {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
    text.parse::<Table>()
        .unwrap_or_else(|e| panic!("parse {path:?}: {e}"))
}

/// The dependency tables a member can declare, at the top level.
///
/// Target-specific tables (`[target.'cfg(…)'.dependencies]`) are not
/// walked: nothing here uses one for a sibling, and the rule this
/// enforces is about where the *version* lives, which a target table
/// would inherit from `[workspace.dependencies]` just the same.
const DEP_TABLES: [&str; 3] = ["dependencies", "dev-dependencies", "build-dependencies"];

/// Whether this manifest's crate can go to crates.io.
///
/// `publish = false` — or an empty allow-list — means it cannot, and a
/// workspace-only crate like that may be depended on by `path` alone.
/// Requiring a version of one would reject a manifest that is correct.
fn is_publishable(manifest: &Table) -> bool {
    match manifest.get("package").and_then(|p| p.get("publish")) {
        None => true,
        Some(Value::Boolean(allowed)) => *allowed,
        Some(Value::Array(registries)) => !registries.is_empty(),
        Some(_) => true,
    }
}

/// The member directories, with a trailing `/*` expanded.
///
/// `members = ["crates/*"]` is valid and common, and taking it literally
/// would look for `crates/*/Cargo.toml` and fail on a workspace that has
/// done nothing wrong. Only the trailing-star form is expanded, which is
/// the one cargo documents; anything else is passed through as written.
fn member_dirs(root: &Path, members: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    for member in members {
        let member = member.as_str().expect("a member entry is a string");
        let Some(parent) = member.strip_suffix("/*") else {
            out.push(member.to_string());
            continue;
        };
        let listing = fs::read_dir(root.join(parent))
            .unwrap_or_else(|e| panic!("read {parent}/ to expand `{member}`: {e}"));
        for entry in listing.flatten() {
            if entry.path().join("Cargo.toml").is_file() {
                out.push(format!("{parent}/{}", entry.file_name().to_string_lossy()));
            }
        }
    }
    out
}

#[test]
fn internal_pins_match_the_workspace_version() {
    let root = workspace_root();
    let root_manifest = manifest(&root.join("Cargo.toml"));
    let workspace = root_manifest
        .get("workspace")
        .expect("the root manifest has a [workspace] table");

    let version = workspace
        .get("package")
        .and_then(|p| p.get("version"))
        .and_then(Value::as_str)
        .expect("[workspace.package] version is set");

    // A dependency with a `path` is one of ours — an outside crate has
    // none. Found rather than named, so a new member is covered without
    // an edit here.
    let deps = workspace
        .get("dependencies")
        .and_then(Value::as_table)
        .expect("[workspace.dependencies] exists");

    let mut checked = 0;
    for (name, dep) in deps {
        let Some(table) = dep.as_table() else {
            continue;
        };
        let Some(path) = table.get("path").and_then(Value::as_str) else {
            continue;
        };

        match table.get("version").and_then(Value::as_str) {
            Some(pinned) => {
                assert_eq!(
                    pinned, version,
                    "\n  {name} is pinned at {pinned} while the workspace is {version}.\n\
                     A release bumps `[workspace.package] version`; this does not follow it, \
                     so it has to be bumped in the same commit.\n"
                );
                checked += 1;
            }
            // No version is correct for a crate that never goes to
            // crates.io — there is no requirement for anyone to resolve.
            // Only the publishable ones are held to the rule.
            None => assert!(
                !is_publishable(&manifest(&root.join(path).join("Cargo.toml"))),
                "{name} is published but depended on by path alone. crates.io needs \
                 a requirement it can resolve for somebody who is not building from \
                 this checkout, so it needs `version = \"{version}\"` too."
            ),
        }
    }

    assert!(
        checked >= 1,
        "expected at least one internal pin to check and found none — have the \
         workspace's own crates left `[workspace.dependencies]`?"
    );
}

#[test]
fn members_inherit_the_workspace_version() {
    let root = workspace_root();
    let root_manifest = manifest(&root.join("Cargo.toml"));
    let members = root_manifest
        .get("workspace")
        .and_then(|w| w.get("members"))
        .and_then(Value::as_array)
        .expect("[workspace] members is set");
    assert!(!members.is_empty(), "no workspace members to check");

    for member in member_dirs(&root, members) {
        let path = root.join(&member).join("Cargo.toml");
        let parsed = manifest(&path);
        let package = parsed
            .get("package")
            .unwrap_or_else(|| panic!("{member} has no [package] table"));

        // `{ workspace = true }`, not a string. A hardcoded version is a
        // second place a release has to remember, and it is the case the
        // substring version of this test could not see.
        let inherits = package
            .get("version")
            .and_then(Value::as_table)
            .and_then(|t| t.get("workspace"))
            .and_then(Value::as_bool)
            == Some(true);
        assert!(
            inherits,
            "{member} sets its own version ({:?}) instead of inheriting it with \
             `version.workspace = true`",
            package.get("version")
        );

        // A sibling reached for by path in a member manifest is the shape
        // `[workspace.dependencies]` exists to replace — it puts the
        // version somewhere other than the one place.
        for table in DEP_TABLES {
            let Some(deps) = parsed.get(table).and_then(Value::as_table) else {
                continue;
            };
            for (name, dep) in deps {
                let has_path = dep.as_table().is_some_and(|t| t.contains_key("path"));
                assert!(
                    !has_path,
                    "{member} declares {name} by path under [{table}]; put it in \
                     `[workspace.dependencies]` and use `{name}.workspace = true`, \
                     so the version behind it stays in one place"
                );
            }
        }
    }
}
