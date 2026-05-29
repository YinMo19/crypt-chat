/**
 * End-to-end encryption — Sender Keys protocol.
 *
 * Each member generates ONE 32-byte sender key on join and uses AES-256-GCM
 * with a monotonic 12-byte nonce (random salt + 64-bit counter) to encrypt
 * every outgoing message. The same ciphertext is broadcast to N receivers,
 * so per-message encryption is O(1) regardless of room size.
 *
 * Sender keys are distributed peer-to-peer using ECDH-derived KEKs:
 *   - When I see a new peer (server told me), I send my sender key to them
 *     wrapped under HKDF(ECDH(myPriv, theirPub)). One-shot, addressed.
 *   - When I learn a peer's sender key from such a frame, I store it; from
 *     then on I can decrypt every message they broadcast.
 *
 * Wire format (binary, base64-encoded for JSON transit):
 *
 *   KEY frame  (kind = 0x02):
 *     [0x02][nonce: 12B][wrapped(48B = 32B sender_key + 16B GCM tag)]
 *     61 bytes total. Sent with `to: peerId` (server unicasts).
 *
 *   MSG frame  (kind = 0x01):
 *     [0x01][nonce: 12B][ciphertext + 16B GCM tag]
 *     ~30B + plaintext length. Broadcast.
 *
 * Server is opaque to all of this: the entire blob is base64'd into the
 * `envelope` field, server-side it's just `&str`.
 *
 * Trade-offs vs full Double Ratchet:
 *   - No forward secrecy beyond the room session: if a key leaks, all of
 *     that user's prior messages in this room are decryptable.
 *   - When a member leaves, future messages are still readable by them
 *     unless we rekey. Rekeying = each remaining member generates a new
 *     sender key and redistributes KEY frames. Cheap (N ECDHs at leave
 *     time), implemented in lib/room.ts.
 *
 * For an ephemeral room destroyed on last-leave, this is the right balance.
 */

import { x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface ReplyRef {
  /** id of the message we are replying to (memberId of its sender — we don't
   * have message ids on the wire, so we approximate "reply to" by sender +
   * a short preview rendered next to our reply). */
  senderId: string;
  /** A short trimmed preview of the original line; used purely for UI hint. */
  preview: string;
}

/** Inline image attachment, fully end-to-end encrypted via the payload. */
export interface ImageAttachment {
  /** Mime type, e.g. "image/jpeg". */
  mime: string;
  /** Base64-encoded image bytes (no data: prefix). */
  data: string;
  /** Decoded width / height in CSS pixels. */
  w: number;
  h: number;
}

export interface PlaintextPayload {
  nickname: string;
  text: string;
  /** Optional reply context. The server timestamp is added on receive — we
   * don't put a client-side `ts` in the payload, so two senders can't
   * disagree about whose clock is right. */
  replyTo?: ReplyRef;
  /** Optional inline image. */
  image?: ImageAttachment;
}

const KEK_INFO = new TextEncoder().encode('crypt-chat:kek:v2');

const KIND_MSG = 0x01;
const KIND_KEY = 0x02;
const KIND_NICK = 0x03;

/** Generate a fresh X25519 keypair. */
export function generateKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** Generate a fresh 32-byte sender key. */
export function generateSenderKey(): Uint8Array {
  return randomBytes(32);
}

/** Derive a 256-bit KEK from an ECDH shared secret. */
function deriveKek(myPriv: Uint8Array, peerPub: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(myPriv, peerPub);
  return hkdf(sha256, shared, undefined, KEK_INFO, 32);
}

/** Build a KEY frame: wrap our sender key for one specific peer. */
export function buildKeyFrame(
  myPriv: Uint8Array,
  peerPub: Uint8Array,
  senderKey: Uint8Array,
): string {
  const kek = deriveKek(myPriv, peerPub);
  const nonce = randomBytes(12);
  const wrapped = gcm(kek, nonce).encrypt(senderKey);
  // [kind][nonce][wrapped]
  const out = new Uint8Array(1 + nonce.length + wrapped.length);
  out[0] = KIND_KEY;
  out.set(nonce, 1);
  out.set(wrapped, 1 + nonce.length);
  return b64encode(out);
}

/** Parse a KEY frame: returns the unwrapped sender key, or null on auth fail. */
export function openKeyFrame(
  myPriv: Uint8Array,
  senderPub: Uint8Array,
  envelope: string,
): Uint8Array | null {
  try {
    const blob = b64decode(envelope);
    if (blob.length < 1 + 12 + 16 || blob[0] !== KIND_KEY) return null;
    const nonce = blob.slice(1, 13);
    const wrapped = blob.slice(13);
    const kek = deriveKek(myPriv, senderPub);
    return gcm(kek, nonce).decrypt(wrapped);
  } catch (e) {
    console.warn('openKeyFrame failed', e);
    return null;
  }
}

/** Build a MSG frame using our sender key. The nonce is `[salt(4B) | counter(8B)]`
 * — the salt is fresh per room session and the counter strictly increases,
 * which makes nonce reuse impossible without bug-level negligence.
 */
export function buildMsgFrame(
  senderKey: Uint8Array,
  nonceSalt: Uint8Array,
  counter: bigint,
  payload: PlaintextPayload,
): string {
  return buildSenderKeyFrame(senderKey, nonceSalt, counter, KIND_MSG, JSON.stringify(payload));
}

/** Build a NICK frame announcing our nickname. Same key + nonce discipline
 * as MSG so the counter space is shared (no nonce reuse). */
export function buildNickFrame(
  senderKey: Uint8Array,
  nonceSalt: Uint8Array,
  counter: bigint,
  nickname: string,
): string {
  return buildSenderKeyFrame(senderKey, nonceSalt, counter, KIND_NICK, nickname);
}

function buildSenderKeyFrame(
  senderKey: Uint8Array,
  nonceSalt: Uint8Array,
  counter: bigint,
  kind: number,
  body: string,
): string {
  const nonce = new Uint8Array(12);
  nonce.set(nonceSalt, 0); // 4 bytes
  let c = counter;
  for (let i = 11; i >= 4; i--) {
    nonce[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const pt = new TextEncoder().encode(body);
  const ct = gcm(senderKey, nonce).encrypt(pt);
  const out = new Uint8Array(1 + nonce.length + ct.length);
  out[0] = kind;
  out.set(nonce, 1);
  out.set(ct, 1 + nonce.length);
  return b64encode(out);
}

/** Parse a MSG frame: returns the decoded payload, or null on auth fail. */
export function openMsgFrame(
  senderKey: Uint8Array,
  envelope: string,
): PlaintextPayload | null {
  const body = openSenderKeyFrame(senderKey, envelope, KIND_MSG);
  if (!body) return null;
  try {
    return JSON.parse(body) as PlaintextPayload;
  } catch {
    return null;
  }
}

/** Parse a NICK frame: returns the nickname string, or null on auth fail. */
export function openNickFrame(
  senderKey: Uint8Array,
  envelope: string,
): string | null {
  return openSenderKeyFrame(senderKey, envelope, KIND_NICK);
}

function openSenderKeyFrame(
  senderKey: Uint8Array,
  envelope: string,
  expectedKind: number,
): string | null {
  try {
    const blob = b64decode(envelope);
    if (blob.length < 1 + 12 + 16 || blob[0] !== expectedKind) return null;
    const nonce = blob.slice(1, 13);
    const ct = blob.slice(13);
    const pt = gcm(senderKey, nonce).decrypt(ct);
    return new TextDecoder().decode(pt);
  } catch (e) {
    console.warn('openSenderKeyFrame failed', e);
    return null;
  }
}

/** Inspect a frame's kind byte. Returns 0 if invalid. */
export function frameKind(envelope: string): number {
  try {
    const blob = b64decode(envelope);
    return blob.length > 0 ? blob[0] : 0;
  } catch {
    return 0;
  }
}

export const FRAME_KIND_MSG = KIND_MSG;
export const FRAME_KIND_KEY = KIND_KEY;
export const FRAME_KIND_NICK = KIND_NICK;

// --- base64 helpers ---

export function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
