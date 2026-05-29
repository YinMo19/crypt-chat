import type { ChatLine } from './room';
import type { ImageAttachment, ReplyRef } from './crypto';

const CACHE_PREFIX = 'crypt-chat:room:v1:';
const MAX_CACHE_LINES = 512;
const MAX_CACHE_CHARS = 4 * 1024 * 1024;

export interface CachedRoom {
  lines: ChatLine[];
  nicknames: Record<string, string>;
}

export function loadRoomCache(roomId: string): CachedRoom | null {
  try {
    const raw = localStorage.getItem(cacheKey(roomId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedRoom>;
    return {
      lines: Array.isArray(parsed.lines)
        ? parsed.lines.flatMap(toChatLine).slice(-MAX_CACHE_LINES)
        : [],
      nicknames: cleanNicknames(parsed.nicknames),
    };
  } catch {
    return null;
  }
}

export function saveRoomCache(
  roomId: string,
  lines: ChatLine[],
  nicknames: Record<string, string>,
): void {
  let cachedLines = lines.slice(-MAX_CACHE_LINES);
  while (true) {
    const raw = JSON.stringify({
      lines: cachedLines,
      nicknames,
    } satisfies CachedRoom);
    if (raw.length <= MAX_CACHE_CHARS) {
      try {
        localStorage.setItem(cacheKey(roomId), raw);
      } catch {
        /* localStorage may be full or unavailable; chat still works. */
      }
      return;
    }
    if (cachedLines.length === 0) return;
    cachedLines = cachedLines.slice(Math.ceil(cachedLines.length / 4));
  }
}

function cacheKey(roomId: string): string {
  return `${CACHE_PREFIX}${roomId}`;
}

function cleanNicknames(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(input)) {
    if (typeof id === 'string' && typeof name === 'string') out[id] = name;
  }
  return out;
}

function toChatLine(input: unknown): ChatLine[] {
  if (!input || typeof input !== 'object') return [];
  const line = input as Record<string, unknown>;
  if (typeof line.id !== 'string' || typeof line.text !== 'string') return [];
  if (line.kind === 'system') {
    const out: ChatLine = { kind: 'system', id: line.id, text: line.text };
    if (typeof line.memberId === 'string' && typeof line.memberName === 'string') {
      out.memberId = line.memberId;
      out.memberName = line.memberName;
    }
    return [out];
  }
  if (
    line.kind !== 'msg' ||
    typeof line.senderId !== 'string' ||
    typeof line.nickname !== 'string' ||
    typeof line.ts !== 'number' ||
    typeof line.mine !== 'boolean'
  ) {
    return [];
  }
  const out: ChatLine = {
    kind: 'msg',
    id: line.id,
    senderId: line.senderId,
    nickname: line.nickname,
    text: line.text,
    ts: line.ts,
    mine: line.mine,
  };
  const replyTo = toReplyRef(line.replyTo);
  const image = toImageAttachment(line.image);
  if (replyTo) out.replyTo = replyTo;
  if (image) out.image = image;
  return [out];
}

function toReplyRef(input: unknown): ReplyRef | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  return typeof value.senderId === 'string' && typeof value.preview === 'string'
    ? { senderId: value.senderId, preview: value.preview }
    : null;
}

function toImageAttachment(input: unknown): ImageAttachment | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  return typeof value.mime === 'string' &&
    typeof value.data === 'string' &&
    typeof value.w === 'number' &&
    typeof value.h === 'number'
    ? { mime: value.mime, data: value.data, w: value.w, h: value.h }
    : null;
}
