//! Guarantees `web/dist/` exists before `rust-embed` looks at it.
//!
//! The SPA bundle is generated (`cargo make web-build`) and gitignored,
//! so a fresh clone has no `web/dist/` at all — and `#[derive(RustEmbed)]`
//! is a hard compile error when its folder is missing:
//!
//! ```text
//! error: #[derive(RustEmbed)] folder '…/web/dist/' does not exist
//! ```
//!
//! Committing a `.gitkeep` was the first attempt and it did not survive:
//! the surrounding `dist/*` ignore rule kept the placeholder out of the
//! repository, so the failure only showed up in a fresh worktree — never
//! on the machine that made the commit. Creating the directory here
//! depends on nothing but cargo, which is the point.
//!
//! An empty directory still compiles to a binary that serves an empty
//! page. That is deliberate: `cargo make smoke` asserts on real markup
//! from the bundle and fails the release if the UI was never built.

fn main() {
    // `create_dir_all` already succeeds when the directory exists, so
    // there is nothing to test for first. Ignoring the error is also
    // deliberate: if the directory truly cannot be created, RustEmbed's
    // own compile error says so more clearly than this could.
    let _ = std::fs::create_dir_all("web/dist");
    println!("cargo:rerun-if-changed=web/dist");
}
