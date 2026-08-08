//! The project registry.
//!
//! A `yaiba` database is one task set, one sync room, one identity — the
//! replication layer has no notion of a project *inside* a database, and
//! `SyncNode::join` deliberately moves the whole replica into the host's
//! room. So a project is a database file, and this module is the index of
//! them: names, where each one lives, and when it was last opened.
//!
//! The index is a plain TOML file next to the databases, meant to survive
//! being hand-edited. It is a convenience layer and nothing more — losing
//! it loses names and ordering, never tasks, and `yaiba --db <path>` keeps
//! working on a database the registry has never heard of.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Registry filename, kept in the same directory as the default database.
const REGISTRY_FILE: &str = "projects.toml";

/// Directory holding databases created by `yaiba join`.
const JOINED_DIR: &str = "projects";

/// Overrides the root that holds the registry and the databases.
const DATA_DIR_ENV: &str = "YAIBA_DATA_DIR";

/// Name given to the database `yaiba` opens when nothing is specified.
pub const DEFAULT_NAME: &str = "default";

/// Bumped only if the on-disk shape changes incompatibly. Readers accept
/// anything they can deserialize; this exists so a future format can tell
/// old files apart without guessing.
const VERSION: u32 = 1;

/// One registered project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    /// What the user calls it. Unique within the registry.
    pub name: String,
    /// Absolute path to the database file.
    pub db: PathBuf,
    /// The ticket this project was joined from, if it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub joined_from: Option<String>,
    /// Drives the picker's ordering.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_opened: Option<DateTime<Utc>>,
}

/// The serialized shape. Split from [`Registry`] so the file's own path
/// isn't part of what gets written into it.
#[derive(Debug, Default, Serialize, Deserialize)]
struct RegistryFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    projects: Vec<Project>,
}

#[derive(Debug)]
pub struct Registry {
    path: PathBuf,
    file: RegistryFile,
}

impl Registry {
    /// `<data dir>/yaiba/projects.toml`.
    pub fn default_path() -> Result<PathBuf> {
        Ok(data_dir()?.join(REGISTRY_FILE))
    }

    /// The database `yaiba` opens when no project and no `--db` is given.
    pub fn default_db() -> Result<PathBuf> {
        Ok(data_dir()?.join("yaiba.db"))
    }

    /// Where `yaiba join` puts a new project's database.
    ///
    /// Relative to the registry's *own* directory rather than the platform
    /// data dir, so an index loaded from somewhere else keeps the databases
    /// it names next to it.
    pub fn joined_db_path(&self, name: &str) -> Result<PathBuf> {
        let dir = self
            .path
            .parent()
            .context("the registry path has no parent directory")?;
        Ok(dir.join(JOINED_DIR).join(format!("{}.db", slug(name))))
    }

    pub fn load() -> Result<Self> {
        Self::load_from(Self::default_path()?)
    }

    /// A missing file is an empty registry — the common case on first run.
    /// A *corrupt* file is an error: overwriting it would silently discard
    /// the user's names, and the fix (open it in an editor) needs the path.
    pub fn load_from(path: PathBuf) -> Result<Self> {
        let file = match std::fs::read_to_string(&path) {
            Ok(text) => toml::from_str(&text).with_context(|| {
                format!(
                    "{} is not valid yaiba registry TOML; fix or delete it",
                    path.display()
                )
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => RegistryFile::default(),
            Err(e) => return Err(e).with_context(|| format!("could not read {}", path.display())),
        };
        Ok(Self { path, file })
    }

    /// Write via a temporary file and rename, so an interrupted save can't
    /// truncate a good registry into an empty one.
    pub fn save(&self) -> Result<()> {
        let dir = self
            .path
            .parent()
            .context("the registry path has no parent directory")?;
        std::fs::create_dir_all(dir)
            .with_context(|| format!("could not create {}", dir.display()))?;

        let mut file = RegistryFile {
            version: VERSION,
            projects: self.file.projects.clone(),
        };
        file.projects.sort_by(|a, b| a.name.cmp(&b.name));
        let text = toml::to_string_pretty(&file).context("could not serialize the registry")?;

        let tmp = self.path.with_extension("toml.tmp");
        std::fs::write(&tmp, text).with_context(|| format!("could not write {}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path)
            .with_context(|| format!("could not replace {}", self.path.display()))?;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Registered projects, most recently opened first. Never-opened ones
    /// sort last, alphabetically, so a fresh registry still reads sensibly.
    pub fn recent(&self) -> Vec<&Project> {
        let mut projects: Vec<&Project> = self.file.projects.iter().collect();
        projects.sort_by(|a, b| {
            b.last_opened
                .cmp(&a.last_opened)
                .then_with(|| a.name.cmp(&b.name))
        });
        projects
    }

    pub fn is_empty(&self) -> bool {
        self.file.projects.is_empty()
    }

    pub fn find(&self, name: &str) -> Option<&Project> {
        self.file.projects.iter().find(|p| p.name == name)
    }

    /// Look a project up by the file it lives in.
    ///
    /// The name is what the user types, but the database is what actually
    /// distinguishes two projects — and names that differ can still land on
    /// one file, because a name becomes a path through [`slug`]. Callers
    /// that are about to *create* a project must ask this, not [`find`].
    pub fn find_by_db(&self, db: &Path) -> Option<&Project> {
        self.file.projects.iter().find(|p| same_path(&p.db, db))
    }

    pub fn names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.file.projects.iter().map(|p| p.name.as_str()).collect();
        names.sort_unstable();
        names
    }

    /// Stop calling a project `(joined)`. Returns whether anything changed.
    ///
    /// `joined_from` is the ticket a project was adopted from, and it is
    /// what the picker's `(joined)` marker reads. Once you have left, that
    /// ticket names a room this replica is no longer in — keeping it would
    /// have `yaiba list` claim a membership that has been given up, and
    /// hand out a ticket that resolves to nobody. The tasks it brought are
    /// yours to keep either way; the label is about the group, not them.
    pub fn clear_joined_from(&mut self, db: &Path) -> bool {
        match self.file.projects.iter_mut().find(|p| same_path(&p.db, db)) {
            Some(project) => project.joined_from.take().is_some(),
            None => false,
        }
    }

    /// Record that `db` is open, and return the name it is filed under.
    ///
    /// Identity is the database path, not the name: opening the same file
    /// twice must not produce two entries, however it was reached. A name
    /// is only invented when the path is new.
    pub fn remember(
        &mut self,
        db: &Path,
        name_hint: Option<&str>,
        joined_from: Option<&str>,
    ) -> Result<String> {
        let db = normalize(db);
        let now = Utc::now();

        if let Some(existing) = self
            .file
            .projects
            .iter_mut()
            .find(|p| same_path(&p.db, &db))
        {
            existing.last_opened = Some(now);
            if let Some(ticket) = joined_from {
                existing.joined_from = Some(ticket.to_string());
            }
            return Ok(existing.name.clone());
        }

        let desired = match name_hint {
            Some(hint) => validate_name(hint)?.to_string(),
            None => self.derive_name(&db),
        };
        let name = self.unique_name(&desired);
        self.file.projects.push(Project {
            name: name.clone(),
            db,
            joined_from: joined_from.map(str::to_string),
            last_opened: Some(now),
        });
        Ok(name)
    }

    /// Adopt the default database if it exists on disk but isn't listed.
    ///
    /// Registration otherwise only happens when the server starts, which
    /// left everyone who had been using yaiba before the registry existed
    /// looking at `yaiba list` claiming they had no projects while their
    /// tasks sat in the default database — and at an empty picker, which
    /// is the one thing the picker must never be.
    ///
    /// `last_opened` comes from the file's mtime. For a SQLite database
    /// that is when yaiba last wrote to it, which is what the field means
    /// and orders the picker correctly from the first run.
    pub fn seed_default(&mut self) -> bool {
        match Self::default_db() {
            Ok(db) => self.seed(&db, DEFAULT_NAME),
            Err(_) => false,
        }
    }

    /// The testable half of [`seed_default`], free of the platform data
    /// directory (and therefore of `YAIBA_DATA_DIR`, which tests must not
    /// mutate — the process environment is shared across parallel tests).
    fn seed(&mut self, db: &Path, name: &str) -> bool {
        let Ok(meta) = std::fs::metadata(db) else {
            return false;
        };
        if self.find_by_db(db).is_some() {
            return false;
        }
        self.file.projects.push(Project {
            name: self.unique_name(name),
            db: normalize(db),
            joined_from: None,
            last_opened: meta.modified().ok().map(DateTime::<Utc>::from),
        });
        true
    }

    /// Whether `name` refers to the default database, which [`seed_default`]
    /// re-adopts on the next run.
    pub fn is_default_db(&self, project: &Project) -> bool {
        Self::default_db().is_ok_and(|db| same_path(&db, &project.db))
    }

    /// Give a project a different name.
    ///
    /// Only the entry changes. The database keeps the path it was created
    /// with, because identity here *is* the path — which is also what
    /// makes a hand-edited rename stick rather than being re-adopted under
    /// the old name. A project renamed from `private` to `personal` still
    /// lives in `projects/private.db`, and a later `new private` is
    /// refused on that file, which is correct but worth knowing.
    pub fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        let to = validate_name(to)?.to_string();
        if from == to {
            return Ok(());
        }
        if self.find(&to).is_some() {
            bail!("a project named {to:?} is already registered");
        }
        let Some(project) = self.file.projects.iter_mut().find(|p| p.name == from) else {
            bail!("no project named {from:?}");
        };
        project.name = to;
        Ok(())
    }

    /// Drop an entry. The database file itself is never touched — a name
    /// is metadata, and deleting someone's tasks is not what "forget" means.
    pub fn forget(&mut self, name: &str) -> Option<Project> {
        let index = self.file.projects.iter().position(|p| p.name == name)?;
        Some(self.file.projects.remove(index))
    }

    /// `~/…/yaiba/yaiba.db` → `default`, anything else → its file stem.
    fn derive_name(&self, db: &Path) -> String {
        if Registry::default_db().is_ok_and(|d| same_path(&d, db)) {
            return DEFAULT_NAME.to_string();
        }
        db.file_stem()
            .and_then(|s| s.to_str())
            .map(sanitize)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "yaiba".to_string())
    }

    /// Two databases can legitimately share a file stem (`a/tasks.db` and
    /// `b/tasks.db`), so a derived name may already be taken.
    fn unique_name(&self, desired: &str) -> String {
        if self.find(desired).is_none() {
            return desired.to_string();
        }
        (2..)
            .map(|n| format!("{desired}-{n}"))
            .find(|candidate| self.find(candidate).is_none())
            .expect("an unbounded counter always yields a free name")
    }
}

/// Where a brand-new project's database goes, refusing every path that
/// would land it on an existing one.
///
/// Lives here rather than in the binary because *every* way of starting a
/// project has to go through it — the CLI's `new` and `join`, and the API
/// the UI calls. A free *name* is not a free *file*: the path is
/// `slug(name)`, so "work" and "work!" both become projects/work.db, and
/// opening an existing database as if it were new either fuses two
/// projects or — for `join` — overwrites the room key and cuts its peer
/// off.
///
/// `db_override` is the caller naming the file itself, a deliberate choice
/// rather than a collision, so it skips the *path* checks — never the name
/// check.
///
/// `escape` is a full noun phrase, not a flag name: it lands inside
/// "or choose {escape}", where a bare `--as` reads as a dangling flag
/// rather than an instruction.
pub fn db_for_new_project(
    registry: &Registry,
    name: &str,
    db_override: Option<&Path>,
    escape: &str,
) -> Result<PathBuf> {
    if let Some(existing) = registry.find(name) {
        bail!(
            "a project named {name:?} is already registered ({}) — open it with \
             `yaiba open {name}`, or choose {escape}",
            existing.db.display()
        );
    }
    if let Some(path) = db_override {
        return Ok(path.to_path_buf());
    }

    let path = registry.joined_db_path(name)?;
    if let Some(existing) = registry.find_by_db(&path) {
        bail!(
            "{name:?} would share a database with the project {:?} ({}) — open that \
             one with `yaiba open {}`, or choose a name that differs by more than \
             punctuation",
            existing.name,
            // The registered path, not the one just built: it is
            // normalized, so it reads as a real path.
            existing.db.display(),
            existing.name
        );
    }
    if path.exists() {
        bail!(
            "{} already exists but no project is registered for it (forgotten \
             earlier?). Choose {escape}, or name that database directly to use it \
             deliberately",
            path.display()
        );
    }
    Ok(path)
}

/// Reject names that would be surprising as a filename or ambiguous in the
/// picker. Deliberately strict: the name becomes part of a path.
pub fn validate_name(name: &str) -> Result<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        bail!("a project name cannot be empty");
    }
    if trimmed.len() > 64 {
        bail!("a project name cannot be longer than 64 characters");
    }
    if trimmed.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        bail!(
            "a project name cannot contain path separators or {:?}",
            r#"*?"<>|:"#
        );
    }
    if matches!(trimmed, "." | "..") {
        bail!("{trimmed:?} is not a usable project name");
    }
    Ok(trimmed)
}

/// A name derived from a ticket, for `yaiba join` without `--as`.
///
/// The endpoint id is the stable half of a ticket, and its first bytes are
/// already how iroh peers are talked about in logs.
pub fn name_from_ticket(ticket: &str) -> String {
    let endpoint = ticket.split('.').next().unwrap_or(ticket);
    let short: String = endpoint
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    if short.is_empty() {
        "peer".to_string()
    } else {
        format!("peer-{}", short.to_ascii_lowercase())
    }
}

/// Interactive fuzzy picker over the registry.
///
/// Errors instead of prompting when stdin isn't a terminal: a picker that
/// blocks a script or a service manager forever is worse than a message
/// saying which name to pass.
pub fn pick<'a>(projects: &[&'a Project]) -> Result<&'a Project> {
    if projects.is_empty() {
        // Reaching here means there is no default database either, since
        // one on disk would already have been adopted. So this is a first
        // run, not a registration that hasn't happened yet.
        bail!("no projects yet — run `yaiba` to start one, or `yaiba join <ticket>`");
    }
    if !std::io::stdin().is_terminal() {
        bail!(
            "no project name given and stdin is not a terminal; pass one of: {}",
            projects
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    let items: Vec<String> = projects.iter().map(|p| label(p)).collect();
    let chosen = dialoguer::FuzzySelect::new()
        .with_prompt("project")
        .items(&items)
        .default(0)
        .interact_opt()
        .context("the project picker failed")?
        .context("no project selected")?;
    Ok(projects[chosen])
}

/// One picker row: the name is what you type, the rest is what disambiguates.
fn label(project: &Project) -> String {
    let when = match project.last_opened {
        Some(t) => t.format("%Y-%m-%d").to_string(),
        None => "never".to_string(),
    };
    let joined = if project.joined_from.is_some() {
        " (joined)"
    } else {
        ""
    };
    format!(
        "{:<20} {:>10}{}  {}",
        project.name,
        when,
        joined,
        project.db.display()
    )
}

/// Everything this module owns lives under one root: the registry, the
/// default database, and the databases `yaiba join` creates.
///
/// `YAIBA_DATA_DIR` moves the whole root, which is the only way to point
/// the registry somewhere else — `--db` names a single database and says
/// nothing about where the index of them belongs. It also makes a
/// self-contained yaiba (a synced folder, a USB stick) one variable.
pub fn data_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os(DATA_DIR_ENV).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    Ok(dirs::data_dir()
        .context("could not determine the platform data directory; pass --db")?
        .join("yaiba"))
}

/// Keep a name usable as a filename component.
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn slug(name: &str) -> String {
    let slug = sanitize(name);
    if slug.is_empty() {
        "project".to_string()
    } else {
        slug
    }
}

/// Absolute, lexically normalized. Not `canonicalize`: the path routinely
/// names a database that doesn't exist yet, which canonicalize refuses.
///
/// On Windows the separator is folded to `\` as well. Both `/` and `\`
/// separate there and either reaches the same file, but [`same_path`]
/// compares bytes — so `C:/x/a.db` and `C:\x\a.db` would otherwise register
/// as two projects over one database. That is easy to hit in practice:
/// `YAIBA_DATA_DIR` typed with forward slashes once and backslashes the
/// next time is enough.
fn normalize(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    if !cfg!(windows) {
        return absolute;
    }
    // Only when the path is valid Unicode: a lossy round-trip could mangle
    // bytes, and a mangled path is worse than an unfolded one.
    match absolute.to_str() {
        Some(text) if text.contains('/') => PathBuf::from(text.replace('/', "\\")),
        _ => absolute,
    }
}

/// Whether two paths name the same database file.
///
/// Exposed because opening every project has to recognise that the active
/// database and a registry entry are the same file — otherwise it opens
/// SQLite twice over one path and replicates a project against itself.
pub fn same_db(a: &Path, b: &Path) -> bool {
    same_path(a, b)
}

/// Whether two paths name the same database file.
///
/// Windows paths are case-insensitive, so the same database reached as
/// `C:\Users\…` and `c:\users\…` must not register twice.
fn same_path(a: &Path, b: &Path) -> bool {
    let (a, b) = (normalize(a), normalize(b));
    if cfg!(windows) {
        a.as_os_str().eq_ignore_ascii_case(b.as_os_str())
    } else {
        a == b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty() -> Registry {
        Registry {
            path: PathBuf::from("registry.toml"),
            file: RegistryFile::default(),
        }
    }

    fn temp_registry() -> Registry {
        let dir = std::env::temp_dir().join(format!("yaiba-reg-{}", uuid_ish()));
        std::fs::create_dir_all(&dir).unwrap();
        Registry::load_from(dir.join(REGISTRY_FILE)).unwrap()
    }

    /// An existing database file to seed from.
    fn touch_db(registry: &Registry, name: &str) -> PathBuf {
        let path = registry.path().parent().unwrap().join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"pretend this is sqlite").unwrap();
        path
    }

    /// Enough entropy to keep parallel test runs off each other's files,
    /// without pulling `uuid` into this crate just for tests.
    fn uuid_ish() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{nanos}-{:?}", std::thread::current().id())
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect()
    }

    #[test]
    fn a_missing_file_is_an_empty_registry() {
        let reg = temp_registry();
        assert!(reg.is_empty());
    }

    #[test]
    fn a_corrupt_file_is_an_error_not_a_fresh_start() {
        let dir = std::env::temp_dir().join(format!("yaiba-reg-{}", uuid_ish()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(REGISTRY_FILE);
        std::fs::write(&path, "this is not toml {{{").unwrap();
        assert!(Registry::load_from(path).is_err());
    }

    #[test]
    fn projects_round_trip_through_the_file() {
        let mut reg = temp_registry();
        reg.remember(Path::new("/tmp/alpha.db"), None, None)
            .unwrap();
        reg.remember(Path::new("/tmp/beta.db"), Some("work"), Some("tick.et"))
            .unwrap();
        reg.save().unwrap();

        let reloaded = Registry::load_from(reg.path().to_path_buf()).unwrap();
        assert_eq!(reloaded.names(), vec!["alpha", "work"]);
        assert_eq!(
            reloaded.find("work").unwrap().joined_from.as_deref(),
            Some("tick.et")
        );
        assert!(reloaded.find("work").unwrap().last_opened.is_some());
    }

    /// The asymmetry that made leaving need its own call, and the reason
    /// it is right: `remember` sets `joined_from` and never clears it, so
    /// merely re-opening a joined project cannot lose the label. Which
    /// also means nothing in the open path will take it off after a
    /// leave — both callers of `SyncNode::leave` have to say so.
    #[test]
    fn reopening_a_joined_project_keeps_its_ticket_but_leaving_clears_it() {
        let mut reg = empty();
        let db = Path::new("/tmp/joined.db");
        reg.remember(db, Some("theirs"), Some("tick.et")).unwrap();

        reg.remember(db, None, None).unwrap();
        assert_eq!(
            reg.find("theirs").unwrap().joined_from.as_deref(),
            Some("tick.et"),
            "opening it again is not leaving it"
        );

        assert!(reg.clear_joined_from(db), "it reports the change");
        assert!(reg.find("theirs").unwrap().joined_from.is_none());
        assert!(
            !reg.clear_joined_from(db),
            "and reports that a second call changed nothing"
        );
        assert!(
            !reg.clear_joined_from(Path::new("/tmp/nowhere.db")),
            "nor invents an entry for a database it has never heard of"
        );
    }

    #[test]
    fn remembering_the_same_database_twice_updates_rather_than_duplicates() {
        let mut reg = empty();
        let first = reg
            .remember(Path::new("/tmp/alpha.db"), None, None)
            .unwrap();
        let second = reg
            .remember(Path::new("/tmp/alpha.db"), Some("ignored"), None)
            .unwrap();
        assert_eq!(first, second, "the established name wins");
        assert_eq!(reg.names().len(), 1);
    }

    #[test]
    fn distinct_databases_sharing_a_stem_get_distinct_names() {
        let mut reg = empty();
        assert_eq!(
            reg.remember(Path::new("/tmp/a/tasks.db"), None, None)
                .unwrap(),
            "tasks"
        );
        assert_eq!(
            reg.remember(Path::new("/tmp/b/tasks.db"), None, None)
                .unwrap(),
            "tasks-2"
        );
    }

    #[test]
    fn recent_orders_by_last_opened_then_name() {
        let mut reg = empty();
        reg.remember(Path::new("/tmp/one.db"), None, None).unwrap();
        reg.remember(Path::new("/tmp/two.db"), None, None).unwrap();
        // Never-opened entries sort last regardless of alphabet.
        reg.file.projects.push(Project {
            name: "aaa-never".into(),
            db: PathBuf::from("/tmp/never.db"),
            joined_from: None,
            last_opened: None,
        });
        let order: Vec<&str> = reg.recent().iter().map(|p| p.name.as_str()).collect();
        assert_eq!(order.last(), Some(&"aaa-never"));
        assert!(order.contains(&"one") && order.contains(&"two"));
    }

    /// Every way of starting a project goes through this, so it is worth
    /// testing here rather than only through whichever caller happens to
    /// exercise it.
    #[test]
    fn a_free_name_gets_a_path_under_the_projects_directory() {
        let registry = temp_registry();
        let path = db_for_new_project(&registry, "work", None, "x").unwrap();
        assert_eq!(path, registry.joined_db_path("work").unwrap());
        assert!(!path.exists());
    }

    #[test]
    fn a_registered_name_is_refused_with_the_callers_escape() {
        let mut registry = temp_registry();
        let db = registry.joined_db_path("work").unwrap();
        registry.remember(&db, Some("work"), None).unwrap();

        let err = db_for_new_project(&registry, "work", None, "another name with --as")
            .unwrap_err()
            .to_string();
        assert!(err.contains("already registered"), "{err}");
        // The escape is interpolated as a phrase, so it reads as a sentence.
        assert!(err.contains("choose another name with --as"), "{err}");
    }

    /// Distinct names, one file — the collision `find` alone cannot see.
    #[test]
    fn a_name_whose_slug_collides_is_refused() {
        let mut registry = temp_registry();
        let db = registry.joined_db_path("work").unwrap();
        registry.remember(&db, Some("work"), None).unwrap();

        let err = db_for_new_project(&registry, "work!", None, "x")
            .unwrap_err()
            .to_string();
        assert!(err.contains("share a database"), "{err}");
    }

    #[test]
    fn a_database_left_behind_by_a_forget_is_refused() {
        let registry = temp_registry();
        let db = registry.joined_db_path("ghost").unwrap();
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        std::fs::write(&db, b"pretend this holds tasks").unwrap();

        let err = db_for_new_project(&registry, "ghost", None, "x")
            .unwrap_err()
            .to_string();
        assert!(err.contains("already exists"), "{err}");
    }

    /// Naming the file yourself skips the *path* checks but never the name
    /// check — otherwise `--db` would be a way to register a duplicate.
    #[test]
    fn an_override_skips_the_path_checks_but_not_the_name_check() {
        let mut registry = temp_registry();
        let db = registry.joined_db_path("work").unwrap();
        registry.remember(&db, Some("work"), None).unwrap();
        let chosen = PathBuf::from("elsewhere.db");

        assert_eq!(
            db_for_new_project(&registry, "fresh", Some(&chosen), "x").unwrap(),
            chosen
        );
        assert!(db_for_new_project(&registry, "work", Some(&chosen), "x").is_err());
    }

    #[test]
    fn rename_keeps_the_database_and_the_entry_identity() {
        let mut reg = empty();
        reg.remember(Path::new("/tmp/private.db"), Some("private"), None)
            .unwrap();
        let db = reg.find("private").unwrap().db.clone();

        reg.rename("private", "personal").unwrap();
        assert_eq!(reg.names(), vec!["personal"]);
        // The file does not move: identity here is the path, which is also
        // what stops the old name being re-adopted alongside the new one.
        assert_eq!(reg.find("personal").unwrap().db, db);
        assert!(reg.find_by_db(&db).is_some());
    }

    #[test]
    fn rename_refuses_a_name_in_use_and_leaves_both_alone() {
        let mut reg = empty();
        reg.remember(Path::new("/tmp/a.db"), Some("shared"), None)
            .unwrap();
        reg.remember(Path::new("/tmp/b.db"), Some("private"), None)
            .unwrap();
        assert!(reg.rename("private", "shared").is_err());
        assert_eq!(reg.names(), vec!["private", "shared"]);
    }

    #[test]
    fn rename_validates_the_new_name() {
        let mut reg = empty();
        reg.remember(Path::new("/tmp/a.db"), Some("work"), None)
            .unwrap();
        assert!(reg.rename("work", "a/b").is_err());
        assert!(reg.rename("nope", "fine").is_err());
        // Renaming to itself is a no-op rather than a self-collision.
        assert!(reg.rename("work", "work").is_ok());
        assert_eq!(reg.names(), vec!["work"]);
    }

    #[test]
    fn forget_removes_only_the_entry() {
        let mut reg = empty();
        reg.remember(Path::new("/tmp/alpha.db"), None, None)
            .unwrap();
        reg.remember(Path::new("/tmp/beta.db"), None, None).unwrap();
        let gone = reg.forget("alpha").unwrap();
        assert_eq!(gone.db, normalize(Path::new("/tmp/alpha.db")));
        assert_eq!(reg.names(), vec!["beta"]);
        assert!(reg.forget("alpha").is_none());
    }

    #[test]
    fn names_that_would_escape_the_registry_are_rejected() {
        for bad in ["", "   ", ".", "..", "a/b", "a\\b", "c:name", "a?b", "a\0b"] {
            assert!(validate_name(bad).is_err(), "{bad:?} should be rejected");
        }
        assert_eq!(validate_name("  team-alpha  ").unwrap(), "team-alpha");
    }

    #[test]
    fn a_derived_join_name_survives_a_weird_ticket() {
        assert_eq!(name_from_ticket("ABCDEFGHIJ.beef"), "peer-abcdefgh");
        assert_eq!(name_from_ticket("...."), "peer");
        assert!(validate_name(&name_from_ticket("....")).is_ok());
    }

    /// Next to the registry that names it, not next to the platform data
    /// dir: an index loaded from elsewhere keeps its databases with it.
    #[test]
    fn a_joined_database_lands_beside_its_registry() {
        let registry = temp_registry();
        let path = registry.joined_db_path("team alpha").unwrap();
        assert_eq!(path.parent().unwrap().file_name().unwrap(), JOINED_DIR);
        assert_eq!(
            path.parent().unwrap().parent().unwrap(),
            registry.path().parent().unwrap()
        );
        assert_eq!(path.file_name().unwrap(), "team-alpha.db");
    }

    /// Distinct names, one file. The uniqueness check in the `join` command
    /// has to consult the path, not the name.
    #[test]
    fn punctuation_collapses_to_the_same_database_path() {
        let registry = temp_registry();
        let plain = registry.joined_db_path("work").unwrap();
        for name in ["work!", "work@", "work?!"] {
            assert_eq!(
                registry.joined_db_path(name).unwrap(),
                plain,
                "{name:?} should collide with \"work\""
            );
        }
    }

    #[test]
    fn find_by_db_ignores_the_name() {
        let mut registry = empty();
        registry
            .remember(Path::new("/tmp/alpha.db"), Some("whatever"), None)
            .unwrap();
        assert_eq!(
            registry
                .find_by_db(Path::new("/tmp/alpha.db"))
                .unwrap()
                .name,
            "whatever"
        );
        assert!(registry.find_by_db(Path::new("/tmp/beta.db")).is_none());
    }

    /// The gap this fixes: a database that exists but was never opened
    /// *since the registry landed* left `yaiba list` claiming there were no
    /// projects, and the picker empty.
    #[test]
    fn an_existing_database_is_adopted_without_having_been_opened() {
        let mut registry = temp_registry();
        let db = touch_db(&registry, "yaiba.db");
        assert!(registry.is_empty());

        assert!(registry.seed(&db, DEFAULT_NAME));
        assert_eq!(registry.names(), vec![DEFAULT_NAME]);
        let project = registry.find(DEFAULT_NAME).unwrap();
        assert!(same_path(&project.db, &db));
        // From the file's mtime, so the picker orders correctly on run one.
        assert!(project.last_opened.is_some());
        assert!(project.joined_from.is_none());
    }

    #[test]
    fn seeding_twice_adds_nothing() {
        let mut registry = temp_registry();
        let db = touch_db(&registry, "yaiba.db");
        assert!(registry.seed(&db, DEFAULT_NAME));
        assert!(!registry.seed(&db, DEFAULT_NAME));
        assert_eq!(registry.names().len(), 1);
    }

    /// Seeding must not invent a project for a database that isn't there —
    /// a genuinely fresh install has nothing to adopt.
    #[test]
    fn nothing_is_seeded_when_the_database_does_not_exist() {
        let mut registry = temp_registry();
        let absent = registry.path().parent().unwrap().join("yaiba.db");
        assert!(!registry.seed(&absent, DEFAULT_NAME));
        assert!(registry.is_empty());
    }

    /// Identity is still the path: a database already filed under another
    /// name must not gain a second entry called `default`.
    #[test]
    fn seeding_respects_a_database_already_registered_under_another_name() {
        let mut registry = temp_registry();
        let db = touch_db(&registry, "yaiba.db");
        registry.remember(&db, Some("mine"), None).unwrap();

        assert!(!registry.seed(&db, DEFAULT_NAME));
        assert_eq!(registry.names(), vec!["mine"]);
    }

    #[test]
    fn windows_paths_compare_case_insensitively() {
        let differs = same_path(Path::new("/tmp/Alpha.db"), Path::new("/tmp/alpha.db"));
        assert_eq!(differs, cfg!(windows));
    }

    /// Regression: `YAIBA_DATA_DIR` written with forward slashes on one run
    /// and backslashes on the next produced two entries over one database —
    /// and, worse, let `join` slip past its collision check into somebody
    /// else's tasks.
    #[test]
    fn windows_treats_both_separators_as_one_path() {
        let same = same_path(Path::new("C:/x/y/a.db"), Path::new("C:\\x\\y\\a.db"));
        assert_eq!(same, cfg!(windows));
    }

    #[test]
    fn find_by_db_survives_a_separator_change() {
        let mut registry = empty();
        registry
            .remember(Path::new("C:\\x\\y\\a.db"), Some("alpha"), None)
            .unwrap();
        let found = registry.find_by_db(Path::new("C:/x/y/a.db")).is_some();
        assert_eq!(found, cfg!(windows));
    }
}
