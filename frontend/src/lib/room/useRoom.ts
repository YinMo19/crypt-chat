/**
 * Room state hook. Glue layer between React and `MlsSession`.
 *
 * End-to-end encryption is handled by MLS (RFC 9420) via ts-mls. The server
 * still only sees opaque bytes:
 *
 *   join.public_key: base64 MLS KeyPackage
 *   relay envelope : base64 MLS private message / commit / welcome
 *
 * The hook owns:
 *   - the WebSocket lifecycle (connect / reconnect with backoff),
 *   - React state (lines / nicknames / members / status),
 *   - the IndexedDB cache (async hydrate, debounced persist),
 *   - an MLS task queue so welcome / add / remove / encrypt happen in order.
 *
 * It delegates all MLS protocol work to `MlsSession`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImageAttachment, PlaintextPayload, ReplyRef } from '../crypto';
import {
  createMlsIdentity,
  decodeKeyPackage,
  identityForKeyPackage,
} from '../mls';
import { cleanNickname } from '../nickname';
import { loadRoomCache, saveRoomCache } from '../roomCache';
import { WsClient, type MemberInfo } from '../ws';
import { MlsSession, type SessionCallbacks } from './session';
import type { ChatLine, PeerEntry, RoomState } from './types';

let lineCounter = 0;
const nextLineId = () => `${Date.now()}-${lineCounter++}`;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;

function reconnectDelayMs(attempt: number): number {
  const capped = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  return capped + Math.floor(Math.random() * Math.min(500, capped / 4));
}

export function useRoom(roomId: string, nickname: string): RoomState {
  const [status, setStatus] = useState<RoomState['status']>('connecting');
  const [wsConnected, setWsConnected] = useState(false);
  const [myId, setMyId] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [nicknames, setNicknames] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<ChatLine[]>([]);

  // Refs we update synchronously from async tasks; mirrors for the React
  // state that the task queue can read without waiting for the next render.
  const nicknamesRef = useRef<Record<string, string>>({});
  const nicknameRef = useRef(cleanNickname(nickname));
  // Visual "X joined" lines are deferred when we don't yet know their
  // nickname, so they aren't rendered as bare ids.
  const pendingJoinLinesRef = useRef<Set<string>>(new Set());
  const sessionRef = useRef<MlsSession | null>(null);
  const clientRef = useRef<WsClient | null>(null);
  const reconnectRef = useRef<((reason: string) => void) | null>(null);
  const connectedOnceRef = useRef(false);
  const queueRef = useRef(Promise.resolve());
  const cacheStateRef = useRef({ lines, nicknames });

  useEffect(() => {
    nicknameRef.current = cleanNickname(nickname);
  }, [nickname]);

  // Async hydration from IndexedDB. If live messages have already arrived
  // by the time the cache loads, the cache is stale by definition — drop
  // it rather than racing with the live state.
  useEffect(() => {
    let alive = true;
    void loadRoomCache(roomId).then((cached) => {
      if (!alive || !cached) return;
      setLines((prev) => (prev.length === 0 ? cached.lines : prev));
      setNicknames((prev) => {
        if (Object.keys(prev).length > 0) return prev;
        nicknamesRef.current = cached.nicknames;
        return cached.nicknames;
      });
    });
    return () => {
      alive = false;
    };
  }, [roomId]);

  useEffect(() => {
    cacheStateRef.current = { lines, nicknames };
    const timer = window.setTimeout(() => {
      void saveRoomCache(roomId, lines, nicknames);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [lines, nicknames, roomId]);

  useEffect(() => {
    return () => {
      // Fire-and-forget on unmount. IndexedDB queues the write at request
      // time, so the put survives the React teardown even though we don't
      // await it.
      void saveRoomCache(
        roomId,
        cacheStateRef.current.lines,
        cacheStateRef.current.nicknames,
      );
    };
  }, [roomId]);

  const pushLine = useCallback((line: ChatLine) => {
    setLines((prev) => {
      const next = [...prev, line];
      const MAX = 2048;
      return next.length > MAX ? next.slice(next.length - MAX) : next;
    });
  }, []);

  const updateNicknames = useCallback(
    (updater: (prev: Record<string, string>) => Record<string, string>) => {
      const next = updater(nicknamesRef.current);
      nicknamesRef.current = next;
      setNicknames(next);
    },
    [],
  );

  const nameForMember = useCallback((id: string) => {
    return cleanNickname(nicknamesRef.current[id] ?? '') || id.slice(0, 6);
  }, []);

  const pushMemberJoinedLine = useCallback(
    (id: string, name?: string) => {
      const nick = cleanNickname(name ?? nicknamesRef.current[id] ?? '') || '';
      if (!nick) {
        pendingJoinLinesRef.current.add(id);
        return;
      }
      pendingJoinLinesRef.current.delete(id);
      pushLine({
        kind: 'system',
        id: nextLineId(),
        memberId: id,
        memberName: nick,
        text: 'joined the room',
      });
    },
    [pushLine],
  );

  const refreshRoster = useCallback(() => {
    const session = sessionRef.current;
    if (!session) {
      setMembers([]);
      return;
    }
    const me = session.getMyId();
    const identity = session.getIdentity();
    const out: MemberInfo[] = [];
    if (me && identity) {
      out.push({ id: me, public_key: identity.encodedKeyPackage });
    }
    for (const peer of session.peers()) {
      out.push({ id: peer.id, public_key: peer.encodedKeyPackage });
    }
    setMembers(out.sort((a, b) => a.id.localeCompare(b.id)));
  }, []);

  const enqueue = useCallback(<T,>(work: () => Promise<T>): Promise<T | null> => {
    const task = queueRef.current.then(work);
    // Reset the queue baseline to a Promise<void>: discard the success
    // value, swallow + log the rejection. Without the success-side mapper
    // TS keeps T in the union and the assignment to Promise<void> fails.
    queueRef.current = task.then(
      () => {},
      (e) => console.warn('room task failed', e),
    );
    return task.catch(() => null);
  }, []);

  const requestReconnect = useCallback((reason: string) => {
    reconnectRef.current?.(reason);
  }, []);

  const sendEnvelope = useCallback((envelope: string, to?: string): boolean => {
    return clientRef.current?.send({ type: 'relay', to, envelope }) ?? false;
  }, []);

  // Build the session callbacks once. `requestReconnect` and `sendEnvelope`
  // are stable; `announceNickname` is invoked off the latest nicknameRef.
  const buildSession = useCallback(
    (): MlsSession => {
      const callbacks: SessionCallbacks = {
        sendEnvelope,
        onError: requestReconnect,
        onReady: () => {
          connectedOnceRef.current = true;
          setStatus('connected');
          // After becoming ready, advertise our current nickname so peers
          // can label our future messages.
          void enqueue(() =>
            sessionRef.current?.announceNickname(nicknameRef.current) ??
            Promise.resolve(),
          );
        },
      };
      return new MlsSession(roomId, callbacks);
    },
    [enqueue, requestReconnect, roomId, sendEnvelope],
  );

  useEffect(() => {
    let alive = true;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    let connecting = false;
    let manualClose = false;
    let outageNotified = false;
    let offMsg: (() => void) | null = null;
    let offClose: (() => void) | null = null;

    const cleanupClient = () => {
      offMsg?.();
      offClose?.();
      offMsg = null;
      offClose = null;
      manualClose = true;
      clientRef.current?.close();
      clientRef.current = null;
      setWsConnected(false);
      manualClose = false;
    };

    const scheduleReconnect = (reason?: string) => {
      if (!alive || reconnectTimer !== null) return;
      sessionRef.current?.markUnready();
      if (connectedOnceRef.current && !outageNotified) {
        outageNotified = true;
        pushLine({
          kind: 'system',
          id: nextLineId(),
          text: reason ? `${reason} - reconnecting` : 'disconnected - reconnecting',
        });
      }
      setStatus('reconnecting');
      const delay = reconnectDelayMs(reconnectAttempt++);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (!alive) return;
        void connectOnce();
      }, delay);
    };

    reconnectRef.current = (reason: string) => {
      if (!alive) return;
      cleanupClient();
      scheduleReconnect(reason);
    };

    const connectOnce = async () => {
      if (!alive || connecting) return;
      connecting = true;
      setStatus(connectedOnceRef.current ? 'reconnecting' : 'connecting');
      cleanupClient();

      const client = new WsClient();
      clientRef.current = client;
      const session = buildSession();
      sessionRef.current = session;
      setMyId(null);
      setMembers([]);

      offMsg = client.onMessage((msg) => {
        if (!alive) return;
        enqueue(async () => {
          switch (msg.type) {
            case 'joined': {
              const wasReconnecting = connectedOnceRef.current;
              session.setMyId(msg.your_id);
              setMyId(msg.your_id);
              updateNicknames((prev) => ({
                ...prev,
                [msg.your_id]: nicknameRef.current,
              }));
              for (const m of msg.members) {
                if (m.id === msg.your_id) continue;
                const kp = decodeKeyPackage(m.public_key);
                if (!kp) continue;
                session.addPeer({
                  id: m.id,
                  keyPackage: kp,
                  encodedKeyPackage: m.public_key,
                  identity: identityForKeyPackage(kp),
                });
              }
              refreshRoster();
              await session.bootstrapIfAlone();
              if (!session.hasState() && session.peerCount() > 0) {
                session.armWelcomeTimeout();
              }
              await session.commitPendingAdds();
              outageNotified = false;
              pushLine({
                kind: 'system',
                id: nextLineId(),
                text: `${wasReconnecting ? 'rejoined' : 'joined'} room "${roomId}" - ${
                  msg.members.length + 1
                } here`,
              });
              break;
            }
            case 'member_joined': {
              if (msg.id === session.getMyId()) return;
              const kp = decodeKeyPackage(msg.public_key);
              if (!kp) return;
              const peer: PeerEntry = {
                id: msg.id,
                keyPackage: kp,
                encodedKeyPackage: msg.public_key,
                identity: identityForKeyPackage(kp),
              };
              session.addPeer(peer);
              session.queuePendingAdd(peer);
              refreshRoster();
              if (!session.hasState()) {
                session.armWelcomeTimeout();
              }
              await session.commitPendingAdds();
              pushMemberJoinedLine(msg.id);
              break;
            }
            case 'member_left': {
              if (msg.id === session.getMyId()) return;
              const peer = session.removePeer(msg.id);
              refreshRoster();
              if (!session.hasState() && session.peerCount() === 0) {
                await session.bootstrapIfAlone();
              } else if (!session.hasState()) {
                session.armWelcomeTimeout();
              }
              if (peer && session.isSponsor()) {
                await session.commitRemove(peer);
              }
              await session.commitPendingAdds();
              pendingJoinLinesRef.current.delete(msg.id);
              pushLine({
                kind: 'system',
                id: nextLineId(),
                memberId: msg.id,
                memberName: nameForMember(msg.id),
                text: 'left the room',
              });
              break;
            }
            case 'message': {
              const result = await session.processIncoming(msg.from, msg.envelope);
              if (result?.kind === 'app') {
                const payload = result.payload;
                const cleanNick =
                  cleanNickname(payload.nickname) || msg.from.slice(0, 6);
                updateNicknames((prev) => ({ ...prev, [msg.from]: cleanNick }));
                if (!payload.text && !payload.image && !payload.replyTo) {
                  if (pendingJoinLinesRef.current.has(msg.from)) {
                    pushMemberJoinedLine(msg.from, cleanNick);
                  }
                  return;
                }
                pushLine({
                  kind: 'msg',
                  id: nextLineId(),
                  senderId: msg.from,
                  nickname: cleanNick,
                  text: payload.text,
                  ts: msg.ts,
                  mine: false,
                  replyTo: payload.replyTo,
                  image: payload.image,
                });
              }
              break;
            }
            case 'error': {
              pushLine({
                kind: 'system',
                id: nextLineId(),
                text: `error: ${msg.reason}`,
              });
              break;
            }
          }
        });
      });

      offClose = client.onClose(() => {
        if (!alive) return;
        if (clientRef.current === client) clientRef.current = null;
        setWsConnected(false);
        if (manualClose) return;
        scheduleReconnect();
      });

      try {
        const identity = await createMlsIdentity(`member:${crypto.randomUUID()}`);
        if (!alive || clientRef.current !== client) return;
        await queueRef.current;
        if (!alive || clientRef.current !== client) return;
        session.resetForJoin(identity);
        await client.connect();
        if (!alive || clientRef.current !== client) return;
        setWsConnected(true);
        client.send({
          type: 'join',
          room: roomId,
          public_key: identity.encodedKeyPackage,
        });
        reconnectAttempt = 0;
      } catch (e) {
        console.warn('room connect failed', e);
        if (!alive || clientRef.current !== client) return;
        client.close();
        scheduleReconnect('room connect failed');
      } finally {
        connecting = false;
      }
    };

    void connectOnce();

    return () => {
      alive = false;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      sessionRef.current?.clearWelcomeTimer();
      reconnectRef.current = null;
      cleanupClient();
    };
  }, [
    buildSession,
    enqueue,
    nameForMember,
    pushLine,
    pushMemberJoinedLine,
    refreshRoster,
    roomId,
    updateNicknames,
  ]);

  // When the user edits their nickname, mirror it into the local roster and
  // broadcast a zero-text app message so peers re-label our future lines.
  useEffect(() => {
    const session = sessionRef.current;
    const me = session?.getMyId();
    if (!me) return;
    updateNicknames((prev) => ({ ...prev, [me]: cleanNickname(nickname) }));
    void enqueue(() =>
      sessionRef.current?.announceNickname(cleanNickname(nickname)) ??
      Promise.resolve(),
    );
  }, [enqueue, nickname, updateNicknames]);

  const send = useCallback(
    (
      text: string,
      opts?: { replyTo?: ReplyRef; image?: ImageAttachment },
    ): Promise<boolean> => {
      return enqueue(async () => {
        const session = sessionRef.current;
        const me = session?.getMyId();
        if (!session || !me || !session.isReady()) return false;
        const trimmed = text.trim();
        if (!trimmed && !opts?.image) return false;

        const payload: PlaintextPayload = {
          nickname: nicknameRef.current,
          text: trimmed,
          replyTo: opts?.replyTo,
          image: opts?.image,
        };

        const ok = await session.encryptAndSend(payload);
        if (!ok) return false;
        pushLine({
          kind: 'msg',
          id: nextLineId(),
          senderId: me,
          nickname: payload.nickname,
          text: payload.text,
          ts: Date.now(),
          mine: true,
          replyTo: opts?.replyTo,
          image: opts?.image,
        });
        return true;
      }).then((ok) => ok === true);
    },
    [enqueue, pushLine],
  );

  return { status, wsConnected, myId, members, nicknames, lines, send };
}
