//! Serves the SPA straight out of the binary.
//!
//! `rust-embed` bakes `web/dist/` in at compile time, which is the whole
//! reason `yaiba` is a single file with nothing to install next to it.

use axum::body::Body;
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct Assets;

/// Static-file handler with SPA fallback: anything that isn't a real
/// asset returns `index.html` so client-side routing works on reload.
pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match Assets::get(path).or_else(|| Assets::get("index.html")) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            // Hashed Vite bundle names make the assets immutable; the
            // HTML shell must not be cached or a rebuild would keep
            // serving the old bundle references.
            let cache = if path.starts_with("assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            (
                [
                    (header::CONTENT_TYPE, mime.as_ref()),
                    (header::CACHE_CONTROL, cache),
                ],
                Body::from(file.data),
            )
                .into_response()
        }
        // Only reachable when the bundle wasn't built before compiling.
        None => (
            StatusCode::NOT_FOUND,
            "yaiba: web assets missing — run `cargo make web-build` and rebuild",
        )
            .into_response(),
    }
}
