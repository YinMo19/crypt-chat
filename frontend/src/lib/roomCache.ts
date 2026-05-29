/**
 * Per-room message cache.
 *
 * Backed by IndexedDB rather than localStorage because a room with even a
 * few inline images quickly blows past localStorage's 5–10 MB origin
 * quota. IndexedDB comfortably holds hundreds of MB per origin.
 *
 * Invariants:
 *   - One DB connection per tab, lazily opened. If the DB cannot be opened
 *     (private mode in some browsers, disabled storage, etc.) every API
 *     becomes a silent no-op — chat keeps working, just without history
 *     across reloads.
 *   - Each room's record is a single JSON-shaped object keyed by roomId.
 *     Per-room cap is `MAX_CACHE_CHARS` of serialized JSON; saves above
 *     the cap drop the oldest 25% of lines until it fits or runs out.
 */

import type { ChatLine } from './room';
import type { ImageAttachment, ReplyRef } from './crypto';

const DB_NAME = 'crypt-chat';
const DB_VERSION = 1;
const STORE = 'rooms';

const MAX_CACHE_LINES = 4096;
/**
 * Per-room cache budget on the serialized JSON length (≈ bytes for the
 * ASCII base64 + JSON we actually store). 32 MiB lets a room keep a few
 * dozen compressed images plus thousands of text lines.
 */
const MAX_CACHE_CHARS = 32 * 1024 * 1024;

export interface CachedRoom {
  lines: ChatLine[];
  nicknames: Record<string, string>;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn('roomCache: indexedDB open failed', req.error);
      resolve(null);
    };
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function runTx<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        let req: IDBRequest<T>;
        try {
          const tx = db.transaction(STORE, mode);
          req = work(tx.objectStore(STORE));
        } catch (e) {
          console.warn('roomCache: tx failed', e);
          resolve(null);
          return;
        }
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          console.warn('roomCache: req failed', req.error);
          resolve(null);
        };
      }),
  );
}

export async function loadRoomCache(roomId: string): Promise<CachedRoom | null> {
  const raw = await runTx<unknown>('readonly', (store) => store.get(roomId));
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Partial<CachedRoom>;
  return {
    lines: Array.isArray(parsed.lines)
      ? parsed.lines.flatMap(toChatLine).slice(-MAX_CACHE_LINES)
      : [],
    nicknames: cleanNicknames(parsed.nicknames),
  };
}

export async function saveRoomCache(
  roomId: string,
  lines: ChatLine[],
  nicknames: Record<string, string>,
): Promise<void> {
  let cachedLines = lines.slice(-MAX_CACHE_LINES);
  // Trim until the serialized payload fits the per-room budget. Each
  // iteration drops the oldest 25%; the array strictly shrinks so the
  // loop converges to []. If we shrink all the way to empty without
  // fitting (the `nicknames` map alone exceeds the budget), give up.
  while (true) {
    const payload: CachedRoom = { lines: cachedLines, nicknames };
    if (JSON.stringify(payload).length <= MAX_CACHE_CHARS) {
      await runTx('readwrite', (store) => store.put(payload, roomId));
      return;
    }
    if (cachedLines.length === 0) return;
    cachedLines = cachedLines.slice(Math.ceil(cachedLines.length / 4));
  }
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
