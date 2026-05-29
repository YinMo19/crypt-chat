//! Embedded static assets. SPA routes fall back to index.html.
//!
//! Asset misses under /assets/ return 404 instead of falling back to HTML —
//! otherwise a missing JS chunk would be served as text/html and the browser
//! would silently fail to load the app.

use axum::body::Body;
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "frontend/dist"]
struct Assets;

pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    // Direct hit: serve the file with a guessed MIME type.
    if !path.is_empty() {
        if let Some(file) = Assets::get(path) {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            return Response::builder()
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(Body::from(file.data.into_owned()))
                .unwrap();
        }

        // Asset paths must hit a real file. Don't fall back to HTML for them,
        // or the browser will try to execute index.html as JS/CSS.
        if path.starts_with("assets/") {
            return (StatusCode::NOT_FOUND, "asset not found").into_response();
        }
    }

    // SPA fallback: any other unknown path returns index.html, letting the
    // client-side router handle it (e.g. /r/abc123).
    match Assets::get("index.html") {
        Some(index) => Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Body::from(index.data.into_owned()))
            .unwrap(),
        None => (StatusCode::NOT_FOUND, "404").into_response(),
    }
}
