mod assets;
mod protocol;
mod room;
mod ws;

use axum::Router;
use axum::routing::get;
use clap::Parser;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::room::Rooms;

#[derive(Parser, Debug)]
#[command(version, about = "crypt-chat: ephemeral E2EE chat rooms")]
struct Args {
    /// Listening port.
    #[arg(short, long, default_value_t = 8080)]
    port: u16,

    /// Listening address.
    #[arg(short, long, default_value = "0.0.0.0")]
    addr: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    let rooms = Rooms::new();

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .fallback(assets::static_handler)
        .with_state(rooms)
        .layer(TraceLayer::new_for_http());

    let bind = format!("{}:{}", args.addr, args.port);
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {bind}: {e}"));

    tracing::info!("crypt-chat listening on http://{bind}");
    axum::serve(listener, app).await.unwrap();
}
