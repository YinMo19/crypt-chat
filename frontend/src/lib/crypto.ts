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
