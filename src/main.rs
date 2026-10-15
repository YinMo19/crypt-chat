mod assets;
mod protocol;
mod room;
mod ws;

use axum::Router;
use axum::routing::get;
use clap::Parser;

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
    let args = Args::parse();
    let rooms = Rooms::new();

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .fallback(assets::static_handler)
        .with_state(rooms);

    let bind = format!("{}:{}", args.addr, args.port);
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .expect("failed to bind");

    axum::serve(listener, app).await.expect("serve failed");
}
