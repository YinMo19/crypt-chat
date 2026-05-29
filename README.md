# crypt-chat

Ephemeral, end-to-end encrypted, single-binary chat rooms.

- **Server is opaque.** Messages are encrypted client-side with MLS
  (Messaging Layer Security, RFC 9420). The server only relays ciphertext
  bytes — it cannot read text, nicknames, replies, or images.
- **No database.** Rooms live in memory; when the last member leaves, the
  room is destroyed. Nothing is persisted.
- **Single binary.** The React/Vite frontend is embedded into the Rust
  binary at build time via [`rust-embed`](https://crates.io/crates/rust-embed).
  Deploying is `scp` the binary, run it.

## Features

- Lock-free relay path: `tokio::broadcast` + `DashMap`, no `Mutex<Room>`.
  Slow clients get kicked instead of stalling the room.
- MLS group key agreement: joins/leaves are committed by a room sponsor and
  delivered as opaque MLS messages; application messages ride MLS epochs.
- 16-character room IDs, server-stamped message timestamps, `@nickname`
  mentions, replies, hover-2s timestamps, virtualized message log
  (2048-line cap, ~constant DOM cost), inline code highlighting,
  client-side image compression (≤5 MiB source → ≤1.2 MiB JPEG).
- Strict IME handling so middle-of-composition Enter never sends.

## Stack

| Layer    | Tech                                                          |
| -------- | ------------------------------------------------------------- |
| Server   | Rust, axum, tokio, DashMap, rust-embed                        |
| Crypto   | `ts-mls` (RFC 9420 MLS), HPKE, WebCrypto                      |
| Frontend | React 18, TypeScript, Tailwind, Vite, @tanstack/react-virtual |
| Font     | JetBrains Mono Variable (self-hosted)                         |
| Highlight| highlight.js (15 languages bundled)                           |

## Build from source

Prereqs: Rust ≥ 1.85, Node ≥ 22, [pnpm](https://pnpm.io/).

```bash
cargo build --release
# the build script runs `pnpm install && pnpm build` inside frontend/
./target/release/crypt-chat --port 8080
# open http://localhost:8080
```

To skip the frontend rebuild step (e.g. iterating on Rust):

```bash
SKIP_FRONTEND_BUILD=1 cargo build --release
```

## Run via container

A linux/amd64 image is published to GHCR on every push to the default
branch:

```
ghcr.io/yinmo19/crypt-chat:latest
```

### One-shot

```bash
podman run --rm -p 8080:8080 ghcr.io/yinmo19/crypt-chat:latest
```

### Compose

The repo ships a `compose.yaml` and `.env.example`. On the host:

```bash
cp .env.example .env
# edit .env to set HOST_PORT, IMAGE_OWNER, IMAGE_TAG
podman compose up -d
```

To pull a fresh `latest` build:

```bash
podman compose pull && podman compose up -d --force-recreate
```

To stop:

```bash
podman compose down
```

The container runs as nonroot, with a read-only root filesystem and all
capabilities dropped. Put it behind a reverse proxy for TLS.

## Reverse proxy notes

`crypt-chat` speaks plain HTTP + WebSocket on the bound port. Any modern
reverse proxy works; the WebSocket endpoint is `/ws`. Caddy example:

```
chat.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## Development

```bash
# terminal 1: backend
cargo run -- --port 8080

# terminal 2: frontend dev server with HMR
cd frontend && pnpm dev
# open http://localhost:5173 — Vite proxies /ws to :8080
```

## Architecture

The server is a thin relay. Joining publishes your MLS KeyPackage; the
server hands every member a roster + pipes opaque MLS envelopes between
them. All identity, message body, image, and nickname material lives inside
the encrypted payload.

```
client  --(Join + KeyPackage)-->  server
        <--(roster)----------
        --(MLS Welcome / Commit)-->  server  --(unicast/broadcast)-->  peers
        --(MLS application message)-->  server  --(broadcast)-->  peers
```

The room itself is a `DashMap<String, Arc<Room>>` and a per-room
`tokio::sync::broadcast::Sender<Arc<str>>`. Pre-serialised JSON frames
ride the broadcast channel as `Arc<str>`; receivers refcount-clone, no
deep copy. Rooms are dropped the moment population hits zero.

## License

MIT. See [LICENSE](./LICENSE).
