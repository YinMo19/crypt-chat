//! Lock-free(-ish) room and member state.
//!
//! Design:
//!   * `Rooms` is a `DashMap<RoomId, Arc<Room>>`. DashMap shards the map
//!     across 64 lock buckets — there is no single global lock. Lookups are
//!     `O(1)` on a sharded RwLock that we hold only for nanoseconds.
//!   * Each `Room` owns a `tokio::sync::broadcast` channel for the hot
//!     fan-out path (relayed encrypted frames). Send is wait-free against
//!     readers; receivers each get their own ring slot.
//!   * Each member additionally owns a bounded `mpsc::Sender` for *direct*
//!     frames (Joined / MemberJoined / KEY relays / Errors) where we need
//!     guaranteed delivery to one specific peer.
//!   * Room population is tracked with an `AtomicUsize`; the room is removed
//!     when it transitions to 0.
//!
//! No `Mutex`, no `RwLock` outside DashMap's internal sharding. The hot
//! relay path performs zero allocation and zero deep clone — frames are
//! pre-serialised into `Arc<str>` once and the broadcast channel hands out
//! refcount-bumped clones to N receivers.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use dashmap::DashMap;
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use crate::protocol::MemberInfo;

/// Hard limits to keep one process bounded under load.
pub const MAX_ROOMS: usize = 10_000;
pub const MAX_MEMBERS_PER_ROOM: usize = 10_000;
/// Broadcast ring size per room. If a slow receiver lags by more than this
/// many frames, it gets a `Lagged` error and we drop them (their socket is
/// too slow to keep up with the room's traffic).
pub const BROADCAST_CAPACITY: usize = 256;
/// Direct mpsc capacity per member. `try_send` failure → kick the client.
pub const DIRECT_CAPACITY: usize = 64;

/// One delivery primitive for both broadcast frames and direct frames.
/// Frames are pre-serialised JSON, ready to push to the WS as-is.
pub type Frame = Arc<str>;

/// Broadcast payload: the frame plus an optional sender id so receivers
/// can filter out their own self-echo without parsing the JSON.
/// `from = None` means "system" frames that should reach everyone (member
/// joined / member left).
#[derive(Clone)]
pub struct BcastFrame {
    pub from: Option<Uuid>,
    pub frame: Frame,
}

pub struct MemberHandle {
    pub id: Uuid,
    pub public_key: String,
    /// Bounded mpsc for direct-to-this-member frames (KEY distribution,
    /// Joined, errors). `try_send` lets us shed load on a stuck client.
    pub direct_tx: mpsc::Sender<Frame>,
}

pub struct Room {
    #[allow(dead_code)]
    pub id: String,
    /// Sharded map of members. Reads (broadcast iteration) are concurrent;
    /// writes (insert/remove) take a short shard-local lock.
    pub members: DashMap<Uuid, Arc<MemberHandle>>,
    /// Population counter, kept in sync with `members.len()` for fast,
    /// lock-free read by joiners checking the cap.
    population: AtomicUsize,
    /// Hot path fan-out channel. Each member task subscribes once.
    pub broadcast_tx: broadcast::Sender<BcastFrame>,
}

impl Room {
    fn new(id: String) -> Arc<Self> {
        let (broadcast_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        Arc::new(Self {
            id,
            members: DashMap::new(),
            population: AtomicUsize::new(0),
            broadcast_tx,
        })
    }

    pub fn population(&self) -> usize {
        self.population.load(Ordering::Relaxed)
    }

    /// Snapshot the current roster. Allocates a fresh Vec, but only called on
    /// join (not the hot relay path).
    pub fn member_infos(&self) -> Vec<MemberInfo> {
        self.members
            .iter()
            .map(|e| MemberInfo {
                id: e.value().id,
                public_key: e.value().public_key.clone(),
            })
            .collect()
    }

    /// Look up a single member's direct channel. Used to route `Relay` frames
    /// addressed with `to: Some(uuid)`.
    pub fn direct_send(&self, target: Uuid, frame: &Frame) -> bool {
        self.members
            .get(&target)
            .is_some_and(|m| m.value().direct_tx.try_send(frame.clone()).is_ok())
    }

    /// Push a frame to the room's broadcast channel. O(1), wait-free against
    /// receivers. Receivers wake up via their own subscriber tasks. The
    /// receiver-side `writer` task is responsible for filtering self-echoes
    /// using `BcastFrame.from`. Returns the number of currently subscribed
    /// receivers (informational).
    pub fn broadcast(&self, from: Option<Uuid>, frame: Frame) -> usize {
        // `send` returns Err if there are no active receivers — that's fine.
        self.broadcast_tx
            .send(BcastFrame { from, frame })
            .unwrap_or(0)
    }

    /// Try to insert a new member. Returns Err if the room is full.
    pub fn try_insert(&self, handle: Arc<MemberHandle>) -> Result<(), &'static str> {
        // Optimistically bump; roll back if we lost the cap race.
        let prev = self.population.fetch_add(1, Ordering::AcqRel);
        if prev >= MAX_MEMBERS_PER_ROOM {
            self.population.fetch_sub(1, Ordering::AcqRel);
            return Err("room is full");
        }
        self.members.insert(handle.id, handle);
        Ok(())
    }

    /// Remove a member. Returns true if the room is now empty.
    fn remove(&self, member_id: Uuid) -> bool {
        if self.members.remove(&member_id).is_some() {
            // Saturating in case of an unbalanced inc somewhere.
            let new = self.population.fetch_sub(1, Ordering::AcqRel).saturating_sub(1);
            return new == 0;
        }
        false
    }
}

#[derive(Clone)]
pub struct Rooms {
    inner: Arc<DashMap<String, Arc<Room>>>,
    total_rooms: Arc<AtomicUsize>,
}

impl Rooms {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(DashMap::new()),
            total_rooms: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Get an existing room, or create one if under the global cap.
    pub fn get_or_create(&self, room_id: &str) -> Result<Arc<Room>, &'static str> {
        if let Some(room) = self.inner.get(room_id) {
            return Ok(room.clone());
        }

        // Creation path: check the global cap with an atomic CAS-loop pattern.
        loop {
            let total = self.total_rooms.load(Ordering::Acquire);
            if total >= MAX_ROOMS {
                return Err("server is at room capacity");
            }
            if self
                .total_rooms
                .compare_exchange(total, total + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                break;
            }
        }

        // We reserved a slot; insert (or pick up an existing room if someone
        // raced us in between). If we lose the race, give the slot back.
        let new_room = Room::new(room_id.to_string());
        match self.inner.entry(room_id.to_string()) {
            dashmap::Entry::Occupied(o) => {
                self.total_rooms.fetch_sub(1, Ordering::AcqRel);
                Ok(o.get().clone())
            }
            dashmap::Entry::Vacant(v) => {
                v.insert(new_room.clone());
                Ok(new_room)
            }
        }
    }

    /// Look up a room without creating one. Returns `None` if missing.
    pub fn peek(&self, room_id: &str) -> Option<Arc<Room>> {
        self.inner.get(room_id).map(|r| r.clone())
    }

    /// Called when a member's socket drops. Removes the member; if the room
    /// became empty, drops the room.
    pub fn remove_member(&self, room_id: &str, member_id: Uuid) {
        let became_empty = match self.inner.get(room_id) {
            Some(room) => room.remove(member_id),
            None => return,
        };

        if became_empty {
            // remove_if guards against a fresh joiner racing in between.
            self.inner.remove_if(room_id, |_, room| room.population() == 0);
            self.total_rooms.fetch_sub(1, Ordering::AcqRel);
            tracing::info!(room = %room_id, "room dropped");
        }
    }
}
