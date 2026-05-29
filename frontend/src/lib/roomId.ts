/**
 * Room ID generation and normalization.
 *
 * Length is always 16. Reasons:
 *   - 16 hex-ish chars over a 32-symbol alphabet ≈ 80 bits of entropy →
 *     collision-free in any practical sense.
 *   - Short rooms are forbidden; if a user types `/r/foo` we expand to a
 *     deterministic 16-char id by appending random padding. This keeps
 *     URLs uniformly shaped and forecloses easy-to-guess room squatting.
 */

const ROOM_ID_LEN = 16;
// Lowercase alphanumeric minus visually ambiguous chars (0/o/1/i/l).
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function isValidRoomId(s: string): boolean {
  if (s.length !== ROOM_ID_LEN) return false;
  for (let i = 0; i < s.length; i++) {
    if (!ALPHABET.includes(s[i])) return false;
  }
  return true;
}

/** Generate a fresh random 16-char room id. */
export function newRoomId(): string {
  const buf = new Uint8Array(ROOM_ID_LEN);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < ROOM_ID_LEN; i++) {
    out += ALPHABET[buf[i] % ALPHABET.length];
  }
  return out;
}

/**
 * Normalize a user-typed room id:
 *   - lowercase
 *   - strip non-alphabet chars
 *   - if shorter than 16, deterministically pad with random alphabet chars
 *     (so `foo` becomes `foo_____________` where _ is fresh randomness)
 *   - if longer than 16, truncate to 16 so every client/server room id has
 *     the same canonical shape
 */
export function normalizeRoomId(input: string): string {
  let s = input.toLowerCase();
  // Strip anything not in the alphabet so users pasting URLs don't break.
  let cleaned = '';
  for (let i = 0; i < s.length; i++) {
    if (ALPHABET.includes(s[i])) cleaned += s[i];
  }
  if (cleaned.length >= ROOM_ID_LEN) return cleaned.slice(0, ROOM_ID_LEN);
  // Pad with fresh randomness, not a fixed pattern, so we don't accidentally
  // funnel everyone who types `foo` into one shared room.
  const padBytes = new Uint8Array(ROOM_ID_LEN - cleaned.length);
  crypto.getRandomValues(padBytes);
  let pad = '';
  for (let i = 0; i < padBytes.length; i++) {
    pad += ALPHABET[padBytes[i] % ALPHABET.length];
  }
  return cleaned + pad;
}

export const ROOM_ID_LENGTH = ROOM_ID_LEN;
