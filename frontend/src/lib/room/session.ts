/**
 * MLS protocol state machine, framework-agnostic.
 *
 * Owns:
 *   - the local identity (KeyPackage),
 *   - the current MLS ClientState,
 *   - the peer roster (excluding self),
 *   - the queue of pending-add peers we haven't committed yet,
 *   - the queue of welcomes we received before having an identity,
 *   - sponsor election (lexicographically smallest member id),
 *   - the welcome-arrival timeout.
 *
 * Does NOT own:
 *   - the WebSocket connection (the host wires `sendEnvelope` for it),
 *   - any React state (the host is responsible for re-rendering on events),
 *   - reconnect backoff (the host requests a reconnect via `onError`).
 *
 * All side-effecting MLS operations (joinWelcome, commit add/remove,
 * encrypt) the host invokes against the session must be serialized
 * externally; `MlsSession` itself is single-threaded by JS semantics but
 * does not guard against concurrent re-entry into its own async methods.
 * The host uses a Promise queue to enforce that ordering.
 */

import type { ClientState } from 'ts-mls';
import type { PlaintextPayload } from '../crypto';
import {
  addMember,
  createInitialGroup,
  encryptPayload,
  joinFromWelcome,
  leafIndexForIdentity,
  processEnvelope,
  removeMember,
  type MlsIdentity,
} from '../mls';
import type { PeerEntry } from './types';

const WELCOME_TIMEOUT_MS = 8_000;

export interface AppMessage {
  kind: 'app';
  from: string;
  payload: PlaintextPayload;
}

export interface SessionCallbacks {
  /** Transmit an MLS frame. Return false if the transport is unavailable. */
  sendEnvelope: (envelope: string, to?: string) => boolean;
  /** Unrecoverable session-level error — host should tear down + reconnect. */
  onError: (reason: string) => void;
  /** Fired once when the MLS state becomes usable (post-bootstrap or post-welcome). */
  onReady: () => void;
}

export class MlsSession {
  private roomId: string;
  private cb: SessionCallbacks;
  private identity: MlsIdentity | null = null;
  private state: ClientState | null = null;
  private myId: string | null = null;
  private peerMap = new Map<string, PeerEntry>();
  private pendingAdds = new Map<string, PeerEntry>();
  private pendingWelcomes: string[] = [];
  private welcomeTimer: number | null = null;
  private ready = false;

  constructor(roomId: string, cb: SessionCallbacks) {
    this.roomId = roomId;
    this.cb = cb;
  }

  // --- Identity / membership wiring ---

  resetForJoin(identity: MlsIdentity): void {
    this.clearWelcomeTimer();
    this.identity = identity;
    this.state = null;
    this.myId = null;
    this.peerMap.clear();
    this.pendingAdds.clear();
    this.pendingWelcomes = [];
    this.ready = false;
  }

  setMyId(id: string): void {
    this.myId = id;
  }

  addPeer(peer: PeerEntry): void {
    this.peerMap.set(peer.id, peer);
  }

  /** Schedule a peer to be added to the MLS group on the next sponsor commit. */
  queuePendingAdd(peer: PeerEntry): void {
    this.pendingAdds.set(peer.id, peer);
  }

  removePeer(id: string): PeerEntry | null {
    const peer = this.peerMap.get(id) ?? null;
    this.peerMap.delete(id);
    this.pendingAdds.delete(id);
    return peer;
  }

  peers(): PeerEntry[] {
    return Array.from(this.peerMap.values());
  }

  peerCount(): number {
    return this.peerMap.size;
  }

  isReady(): boolean {
    return this.ready;
  }

  hasState(): boolean {
    return this.state !== null;
  }

  getMyId(): string | null {
    return this.myId;
  }

  getIdentity(): MlsIdentity | null {
    return this.identity;
  }

  // --- Sponsor election ---

  sponsorId(): string | null {
    if (!this.state) return null;
    const ids: string[] = [];
    if (
      this.myId &&
      this.identity &&
      leafIndexForIdentity(this.state, this.identity.identity) !== null
    ) {
      ids.push(this.myId);
    }
    for (const peer of this.peerMap.values()) {
      if (leafIndexForIdentity(this.state, peer.identity) !== null) {
        ids.push(peer.id);
      }
    }
    ids.sort();
    return ids[0] ?? null;
  }

  isSponsor(): boolean {
    return this.myId !== null && this.sponsorId() === this.myId;
  }

  // --- Welcome timeout ---

  /**
   * Arm a timer that fires onError if we still have peers but no MLS state
   * after WELCOME_TIMEOUT_MS. Indicates we joined a populated room but
   * nobody sponsored us — easiest recovery is a fresh reconnect.
   */
  armWelcomeTimeout(): void {
    this.clearWelcomeTimer();
    if (this.state || this.peerMap.size === 0) return;
    this.welcomeTimer = window.setTimeout(() => {
      this.welcomeTimer = null;
      if (!this.state && this.peerMap.size > 0) {
        this.cb.onError('MLS welcome timed out');
      }
    }, WELCOME_TIMEOUT_MS);
  }

  clearWelcomeTimer(): void {
    if (this.welcomeTimer !== null) {
      window.clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
    }
  }

  /**
   * Mark the session as no-longer-sendable without tearing down protocol
   * state. The host calls this on disconnect so that send/announce
   * attempts during the reconnect gap fail fast instead of trying to
   * push through a dead socket.
   */
  markUnready(): void {
    this.ready = false;
    this.clearWelcomeTimer();
  }

  // --- MLS state transitions ---

  /**
   * Create the initial single-member group. Only valid when we have no
   * peers; subsequent peers will be added in via sponsor commits.
   */
  async bootstrapIfAlone(): Promise<void> {
    if (!this.identity || this.state || this.peerMap.size > 0) return;
    this.state = await createInitialGroup(this.roomId, this.identity);
    this.markReady();
  }

  /**
   * Drain queued welcomes until one of them produces a usable state. A
   * welcome that fails to decode (returns null) is benign and we move on
   * to the next; one that decodes but fails to join throws — that's a
   * hard error, drop the rest and reconnect.
   */
  async tryJoinPendingWelcome(): Promise<void> {
    if (this.state || !this.identity) return;
    while (this.pendingWelcomes.length > 0) {
      const welcome = this.pendingWelcomes.shift()!;
      let state: ClientState | null;
      try {
        state = await joinFromWelcome(welcome, this.identity);
      } catch (e) {
        console.warn('MLS join failed', e);
        this.pendingWelcomes = [];
        this.cb.onError('MLS join failed');
        return;
      }
      if (!state) continue;
      this.state = state;
      this.markReady();
      return;
    }
  }

  /** Commit every pending add, but only if we are the sponsor. */
  async commitPendingAdds(): Promise<void> {
    if (!this.isSponsor() || !this.state) return;
    for (const peer of Array.from(this.pendingAdds.values())) {
      await this.commitAdd(peer);
    }
  }

  private async commitAdd(peer: PeerEntry): Promise<void> {
    const state = this.state;
    if (!state) return;
    const result = await addMember(state, peer.keyPackage);
    this.state = result.state;
    this.pendingAdds.delete(peer.id);
    // Fan the commit out to all *existing* members (anyone already in the
    // MLS group at the pre-commit epoch). The newcomer gets the welcome.
    for (const existing of this.peerMap.values()) {
      if (existing.id === peer.id) continue;
      if (leafIndexForIdentity(state, existing.identity) !== null) {
        if (!this.cb.sendEnvelope(result.bundle.commit, existing.id)) {
          this.cb.onError('MLS commit send failed');
          return;
        }
      }
    }
    if (!this.cb.sendEnvelope(result.bundle.welcome, peer.id)) {
      this.cb.onError('MLS welcome send failed');
    }
  }

  /**
   * Sponsor-side remove. The caller decides when to invoke this (typically
   * on a 'member_left' notification when we're the sponsor).
   */
  async commitRemove(peer: PeerEntry): Promise<void> {
    const state = this.state;
    if (!state) return;
    const leafIndex = leafIndexForIdentity(state, peer.identity);
    if (leafIndex === null) return;
    const result = await removeMember(state, leafIndex);
    this.state = result.state;
    if (!this.cb.sendEnvelope(result.commit)) {
      this.cb.onError('MLS remove send failed');
    }
  }

  /**
   * Process an inbound envelope. Returns either an app-level message for
   * the host to render, or null for protocol-only frames (commits,
   * welcomes the host should re-queue, etc.).
   */
  async processIncoming(from: string, envelope: string): Promise<AppMessage | null> {
    if (!this.state) {
      // We haven't joined yet: stash the envelope as a candidate welcome
      // and try to join from it.
      this.pendingWelcomes.push(envelope);
      await this.tryJoinPendingWelcome();
      return null;
    }
    try {
      const processed = await processEnvelope(this.state, envelope);
      this.state = processed.state;
      this.prunePendingAdds();
      const app: AppMessage | null =
        processed.result?.kind === 'app'
          ? { kind: 'app', from, payload: processed.result.payload }
          : null;
      // Always try to flush pending adds afterwards — a non-sponsor's
      // commit message may have advanced our epoch to one where we are
      // now the sponsor with adds to commit.
      await this.commitPendingAdds();
      return app;
    } catch (e) {
      console.warn('MLS envelope failed', e);
      this.cb.onError('MLS envelope failed');
      return null;
    }
  }

  /** Encrypt + transmit a payload as our own application message. */
  async encryptAndSend(payload: PlaintextPayload): Promise<boolean> {
    const state = this.state;
    if (!state || !this.ready) return false;
    try {
      const result = await encryptPayload(state, payload);
      this.state = result.state;
      if (!this.cb.sendEnvelope(result.envelope)) {
        this.cb.onError('send failed');
        return false;
      }
      return true;
    } catch (e) {
      console.warn('MLS send failed', e);
      this.cb.onError('MLS send failed');
      return false;
    }
  }

  /**
   * Send a zero-text application message just to advertise our nickname
   * to the group. Used right after joining and whenever the user edits
   * their nickname.
   */
  async announceNickname(nickname: string): Promise<void> {
    if (!this.state || !this.myId || !this.ready) return;
    try {
      const result = await encryptPayload(this.state, { nickname, text: '' });
      this.state = result.state;
      if (!this.cb.sendEnvelope(result.envelope)) {
        this.cb.onError('MLS nickname send failed');
      }
    } catch (e) {
      console.warn('MLS nickname announcement failed', e);
      this.cb.onError('MLS nickname failed');
    }
  }

  // --- Private helpers ---

  /**
   * After a commit advances our epoch, any pending-add peer that's now in
   * the tree was added by someone else's commit — drop it from our own
   * queue so we don't try to re-add it.
   */
  private prunePendingAdds(): void {
    if (!this.state) return;
    for (const [id, peer] of this.pendingAdds) {
      if (leafIndexForIdentity(this.state, peer.identity) !== null) {
        this.pendingAdds.delete(id);
      }
    }
  }

  private markReady(): void {
    this.ready = true;
    this.clearWelcomeTimer();
    this.cb.onReady();
  }
}
