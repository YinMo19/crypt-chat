//! WebSocket upgrade and frame routing.
//!
//! Hot path properties:
//!   * No `serde_json::Value` in transit — relayed envelopes stay as opaque
//!     `&str` borrowed from the inbound frame, serialised once into an
//!     `Arc<str>`, and refcount-cloned to N receivers via `tokio::broadcast`.
//!   * No `Mutex<Room>`. All access is sharded (DashMap) or atomic
//!     (broadcast / mpsc / AtomicUsize).
//!   * Slow / lagging receivers are kicked instead of stalling the room.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use crate::protocol::{ClientMsg, MemberInfo, ServerMsg, is_valid_room_id};
use crate::room::{BcastFrame, DIRECT_CAPACITY, Frame, MemberHandle, Room, Rooms};

/// Cap an inbound text frame at this many bytes to prevent memory abuse.
/// 6 MiB accommodates a compressed image payload (≤1.2 MiB raw) after
/// base64 (~33% expansion) plus JSON wrapping plus generous text headroom.
/// The compressor targets ≤1.2 MiB output, so envelopes typically land
/// around 1.6 MiB on the wire — well inside the cap.
const MAX_INBOUND_FRAME: usize = 6 * 1024 * 1024;

pub async fn ws_handler(ws: WebSocketUpgrade, State(rooms): State<Rooms>) -> Response {
    // Cap the per-frame payload up front; tower-http's max body limit
    // doesn't apply to WS, so we set it on the upgrade.
    ws.max_message_size(MAX_INBOUND_FRAME)
        .max_frame_size(MAX_INBOUND_FRAME)
        .on_upgrade(move |socket| handle_socket(socket, rooms))
}

/// Serialise a ServerMsg once into an Arc<str> ready to push to the wire.
fn encode<'a>(msg: &ServerMsg<'a>) -> Frame {
    // serde_json::to_string is cheap; we do this O(1) times per inbound event.
    Arc::from(serde_json::to_string(msg).unwrap_or_default())
}

/// Wall-clock timestamp in milliseconds since UNIX epoch. Server-stamped so
/// every recipient sees the same value regardless of clock skew.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn handle_socket(socket: WebSocket, rooms: Rooms) {
    let (mut sender, mut receiver) = socket.split();
    let (direct_tx, mut direct_rx) = mpsc::channel::<Frame>(DIRECT_CAPACITY);

    // First frame must be Join. Read it before spawning the writer so that
    // join failures are simple and don't need cross-task cleanup.
    let first = match receiver.next().await {
        Some(Ok(Message::Text(s))) => s,
        _ => return,
    };

    let (room_id, public_key) = match serde_json::from_str::<ClientMsg>(&first) {
        Ok(ClientMsg::Join { room, public_key }) => (room, public_key),
        _ => {
            let frame = encode(&ServerMsg::Error {
                reason: "first frame must be join",
            });
            let _ = sender.send(Message::Text(frame.to_string())).await;
            return;
        }
    };

    if !is_valid_room_id(&room_id) {
        let frame = encode(&ServerMsg::Error {
            reason: "invalid room id",
        });
        let _ = sender.send(Message::Text(frame.to_string())).await;
        return;
    }

    // Look up / create the room (capped). Errors → tell the client and bail.
    let room: Arc<Room> = match rooms.get_or_create(&room_id) {
        Ok(r) => r,
        Err(reason) => {
            let frame = encode(&ServerMsg::Error { reason });
            let _ = sender.send(Message::Text(frame.to_string())).await;
            return;
        }
    };

    let my_id = Uuid::new_v4();

    // Subscribe to the room's broadcast channel BEFORE inserting ourselves
    // into the roster, so we cannot miss the very next broadcast frame.
    let mut bcast_rx: broadcast::Receiver<BcastFrame> = room.broadcast_tx.subscribe();

    let handle = Arc::new(MemberHandle {
        id: my_id,
        public_key: public_key.clone(),
        direct_tx: direct_tx.clone(),
    });

    if let Err(reason) = room.try_insert(handle) {
        let frame = encode(&ServerMsg::Error { reason });
        let _ = sender.send(Message::Text(frame.to_string())).await;
        return;
    }

    // Direct: tell ourselves the assigned id + roster snapshot.
    let snapshot = room.member_infos();
    // Filter ourselves out of the snapshot (we just inserted, so we'd see it).
    let snapshot: Vec<MemberInfo> = snapshot.into_iter().filter(|m| m.id != my_id).collect();
    let joined_self = encode(&ServerMsg::Joined {
        your_id: my_id,
        members: snapshot,
    });
    let _ = direct_tx.try_send(joined_self);

    // Broadcast: tell existing members about us. Tag the broadcast with
    // our own id so the writer task filters it out of our own stream —
    // otherwise we'd receive our own MemberJoined and double-count
    // ourselves in the roster.
    let joined_announce = encode(&ServerMsg::MemberJoined(MemberInfo {
        id: my_id,
        public_key,
    }));
    room.broadcast(Some(my_id), joined_announce);

    tracing::info!(room = %room_id, member = %my_id, "joined");

    // Writer task: pump direct frames + broadcast frames to the WS in order.
    // Lagging on the broadcast channel kicks us — better than stalling the
    // room with backpressure.
    let writer_my_id = my_id;
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                // Direct frames take priority — they are always small and rare.
                direct = direct_rx.recv() => {
                    let Some(frame) = direct else { break };
                    if sender.send(Message::Text(frame.to_string())).await.is_err() {
                        break;
                    }
                }
                bcast = bcast_rx.recv() => {
                    match bcast {
                        Ok(BcastFrame { from, frame }) => {
                            // Drop our own broadcasts: clients send Relay
                            // without `to`, the server fans out — receivers
                            // would otherwise see their own messages echo.
                            if from == Some(writer_my_id) {
                                continue;
                            }
                            if sender.send(Message::Text(frame.to_string())).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(
                                member = %writer_my_id,
                                lagged = n,
                                "client lagged, dropping"
                            );
                            break;
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
        let _ = sender.close().await;
    });

    // Reader loop: handle inbound frames from this client.
    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(s) => {
                if s.len() > MAX_INBOUND_FRAME {
                    let frame = encode(&ServerMsg::Error {
                        reason: "frame too large",
                    });
                    let _ = direct_tx.try_send(frame);
                    continue;
                }
                let parsed: Result<ClientMsg, _> = serde_json::from_str(&s);
                match parsed {
                    Ok(ClientMsg::Relay { to, envelope }) => {
                        // Encode the outgoing frame ONCE, with the server-
                        // stamped receive time, then either direct-deliver
                        // or broadcast as appropriate.
                        let outgoing = encode(&ServerMsg::Message {
                            from: my_id,
                            ts: now_ms(),
                            envelope: &envelope,
                        });
                        match to {
                            Some(target) if target != my_id => {
                                let _ = room.direct_send(target, &outgoing);
                            }
                            Some(_) => { /* addressed to self → drop */ }
                            None => {
                                // Tag with our id so the writer task can
                                // filter our own self-echo.
                                room.broadcast(Some(my_id), outgoing);
                            }
                        }
                    }
                    Ok(ClientMsg::Join { .. }) => {
                        let frame = encode(&ServerMsg::Error {
                            reason: "already joined",
                        });
                        let _ = direct_tx.try_send(frame);
                    }
                    Err(_) => {
                        let frame = encode(&ServerMsg::Error {
                            reason: "bad frame",
                        });
                        let _ = direct_tx.try_send(frame);
                    }
                }
            }
            Message::Close(_) => break,
            // We deliberately ignore Ping/Pong/Binary; axum auto-replies to Ping.
            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => {}
        }
    }

    // Cleanup. Remove from roster, then announce departure to remaining peers.
    rooms.remove_member(&room_id, my_id);
    if let Some(room) = rooms.peek(&room_id) {
        let frame = encode(&ServerMsg::MemberLeft { id: my_id });
        // Pass our own id so we filter ourselves out (defensive — the
        // writer is about to abort anyway).
        room.broadcast(Some(my_id), frame);
    }
    tracing::info!(room = %room_id, member = %my_id, "left");

    writer.abort();
}
