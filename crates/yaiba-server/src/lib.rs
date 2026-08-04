//! HTTP surface for `yaiba`: the local API plus the SPA baked into the
//! binary.
//!
//! Exposed as a library so the release smoke test can stand the real
//! server up in-process rather than shelling out to the executable and
//! guessing at its readiness.

pub mod api;
pub mod mcp;
pub mod projects;
pub mod updater;
pub mod web;

use axum::Router;
use tower_http::trace::TraceLayer;

/// Everything served on the local port: `/api/*` first, every other
/// path falling through to the embedded bundle.
pub fn app(state: api::AppState) -> Router {
    Router::new()
        .merge(api::router(state))
        .fallback(web::serve)
        .layer(TraceLayer::new_for_http())
}
