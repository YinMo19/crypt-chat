//! Client ↔ server WebSocket protocol frames.
//!
//! The server never inspects the `envelope` field; it is opaque ciphertext
//! (base64 of a binary blob) to the server. The optional `to` field on Relay
//! lets a client route a frame to a single peer (used for sender-key
//! distribution to a freshly-joined member); without it the server fans out
//! to every other member.
//!
//! `Message::ts` is server-stamped at the moment the relay arrives, so all
//! recipients see the same authoritative timestamp regardless of clock skew.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Client → Server.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// Join a room (must be the first frame on a new connection).
    Join { room: String, public_key: String },
    /// Relay an opaque envelope. With `to: Some(uuid)` the server delivers it
    /// to that peer only; with `to: None` it broadcasts to every other member.
    Relay {
        #[serde(default)]
        to: Option<Uuid>,
        envelope: String,
    },
}

/// Server → Client. We use `&str` for the hot relay path so that
/// pre-serialised bytes can be borrowed instead of cloned per recipient.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg<'a> {
    /// Join succeeded — assigned ID and current roster.
    Joined {
        your_id: Uuid,
        members: Vec<MemberInfo>,
    },
    /// A new member joined; broadcast to existing members.
    MemberJoined(MemberInfo),
    /// A member left.
    MemberLeft { id: Uuid },
    /// A relayed encrypted envelope from another member, with the
    /// server-stamped receive time in milliseconds since epoch.
    Message {
        from: Uuid,
        ts: u64,
        envelope: &'a str,
    },
    /// Protocol error.
    Error { reason: &'a str },
}

#[derive(Debug, Serialize, Clone)]
pub struct MemberInfo {
    pub id: Uuid,
    pub public_key: String,
}
