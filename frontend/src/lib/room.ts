/**
 * Room state hook.
 *
 * End-to-end encryption is handled by MLS (RFC 9420) via ts-mls. The server
 * still only sees opaque bytes:
 *
 *   join.public_key: base64 MLS KeyPackage
 *   relay envelope : base64 MLS private message / commit / welcome
 *
 * The current sponsor is the lexicographically-smallest member id in the
 * roster. Sponsors commit add/remove changes; every member processes the MLS
 * commit and advances to the new epoch. This replaces the previous all-peers
 * sender-key redistribution on leave.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PlaintextPayload, ReplyRef, type ImageAttachment } from './crypto';
import {
  addMember,
  createInitialGroup,
  createMlsIdentity,
  decodeKeyPackage,
  encryptPayload,
  identityForKeyPackage,
  joinFromWelcome,
  leafIndexForIdentity,
  processEnvelope,
  removeMember,
  type MlsIdentity,
} from './mls';
import { cleanNickname } from './nickname';
import { WsClient, type MemberInfo } from './ws';
import type { ClientState, KeyPackage } from 'ts-mls';

export type ChatLine =
  | {
      kind: 'msg';
      id: string;
      senderId: string;
      nickname: string;
      text: string;
      ts: number;
      mine: boolean;
      replyTo?: ReplyRef;
      image?: ImageAttachment;
    }
  | { kind: 'system'; id: string; text: string };

interface PeerEntry {
  id: string;
  keyPackage: KeyPackage;
  encodedKeyPackage: string;
  identity: string;
}

let lineCounter = 0;
const nextLineId = () => `${Date.now()}-${lineCounter++}`;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const WELCOME_TIMEOUT_MS = 8_000;

function reconnectDelayMs(attempt: number): number {
  const capped = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  return capped + Math.floor(Math.random() * Math.min(500, capped / 4));
}

export interface RoomState {
  status: 'connecting' | 'connected' | 'reconnecting' | 'closed';
  myId: string | null;
  /** Full roster including me. Stable across re-renders only when the set
   * of ids changes; consumers should treat the array as immutable. */
  members: MemberInfo[];
  /** id -> nickname map. Self always present. */
  nicknames: Record<string, string>;
  lines: ChatLine[];
  send: (
    text: string,
    opts?: { replyTo?: ReplyRef; image?: ImageAttachment },
  ) => void;
}

export function useRoom(roomId: string, nickname: string): RoomState {
  const [status, setStatus] = useState<RoomState['status']>('connecting');
  const [myId, setMyId] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [nicknames, setNicknames] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<ChatLine[]>([]);

  const identityRef = useRef<MlsIdentity | null>(null);
  const mlsStateRef = useRef<ClientState | null>(null);
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const pendingAddsRef = useRef<Map<string, PeerEntry>>(new Map());
  const pendingWelcomesRef = useRef<string[]>([]);
  const clientRef = useRef<WsClient | null>(null);
  const reconnectRef = useRef<((reason: string) => void) | null>(null);
  const welcomeTimerRef = useRef<number | null>(null);
  const myIdRef = useRef<string | null>(null);
  const nicknameRef = useRef(cleanNickname(nickname));
  const readyRef = useRef(false);
  const connectedOnceRef = useRef(false);
  const queueRef = useRef(Promise.resolve());

  useEffect(() => {
    nicknameRef.current = cleanNickname(nickname);
  }, [nickname]);

  const pushLine = useCallback((line: ChatLine) => {
    setLines((prev) => {
      const next = [...prev, line];
      const MAX = 2048;
      return next.length > MAX ? next.slice(next.length - MAX) : next;
    });
  }, []);

  const refreshRoster = useCallback(() => {
    const me = myIdRef.current;
    const identity = identityRef.current;
    const out: MemberInfo[] = [];
    if (me && identity) {
      out.push({ id: me, public_key: identity.encodedKeyPackage });
    }
    for (const peer of peersRef.current.values()) {
      out.push({ id: peer.id, public_key: peer.encodedKeyPackage });
    }
    setMembers(out.sort((a, b) => a.id.localeCompare(b.id)));
  }, []);

  const enqueue = useCallback((work: () => Promise<void>) => {
    queueRef.current = queueRef.current
      .then(work)
      .catch((e) => console.warn('room task failed', e));
  }, []);

  const sponsorId = useCallback((): string | null => {
    const state = mlsStateRef.current;
    if (!state) return null;
    const ids: string[] = [];
    const me = myIdRef.current;
    const identity = identityRef.current;
    if (
      me &&
      identity &&
      leafIndexForIdentity(state, identity.identity) !== null
    ) {
      ids.push(me);
    }
    for (const peer of peersRef.current.values()) {
      if (leafIndexForIdentity(state, peer.identity) !== null) {
        ids.push(peer.id);
      }
    }
    ids.sort();
    return ids[0] ?? null;
  }, []);

  const isSponsor = useCallback(() => {
    const me = myIdRef.current;
    return !!me && sponsorId() === me;
  }, [sponsorId]);

  const requestReconnect = useCallback((reason: string) => {
    reconnectRef.current?.(reason);
  }, []);

  const clearWelcomeTimer = useCallback(() => {
    if (welcomeTimerRef.current === null) return;
    window.clearTimeout(welcomeTimerRef.current);
    welcomeTimerRef.current = null;
  }, []);

  const armWelcomeTimeout = useCallback(() => {
    clearWelcomeTimer();
    if (mlsStateRef.current || peersRef.current.size === 0) return;
    welcomeTimerRef.current = window.setTimeout(() => {
      welcomeTimerRef.current = null;
      if (!mlsStateRef.current && peersRef.current.size > 0) {
        requestReconnect('MLS welcome timed out');
      }
    }, WELCOME_TIMEOUT_MS);
  }, [clearWelcomeTimer, requestReconnect]);

  const sendEnvelope = useCallback((envelope: string, to?: string): boolean => {
    return clientRef.current?.send({ type: 'relay', to, envelope }) ?? false;
  }, []);

  const resetCryptoForJoin = useCallback((identity: MlsIdentity) => {
    clearWelcomeTimer();
    identityRef.current = identity;
    mlsStateRef.current = null;
    peersRef.current.clear();
    pendingAddsRef.current.clear();
    pendingWelcomesRef.current = [];
    myIdRef.current = null;
    readyRef.current = false;
    setMyId(null);
    setMembers([]);
  }, [clearWelcomeTimer]);

  const tryJoinPendingWelcome = useCallback(async () => {
    if (mlsStateRef.current || !identityRef.current) return;
    while (pendingWelcomesRef.current.length > 0) {
      const welcome = pendingWelcomesRef.current.shift()!;
      const state = await joinFromWelcome(welcome, identityRef.current);
      if (!state) continue;
      mlsStateRef.current = state;
      readyRef.current = true;
      connectedOnceRef.current = true;
      clearWelcomeTimer();
      setStatus('connected');
      return;
    }
  }, [clearWelcomeTimer]);

  const commitAdd = useCallback(
    async (peer: PeerEntry) => {
      const state = mlsStateRef.current;
      if (!state) return;
      const result = await addMember(state, peer.keyPackage);
      mlsStateRef.current = result.state;
      pendingAddsRef.current.delete(peer.id);
      for (const existing of peersRef.current.values()) {
        if (existing.id === peer.id) continue;
        if (leafIndexForIdentity(state, existing.identity) !== null) {
          if (!sendEnvelope(result.bundle.commit, existing.id)) {
            requestReconnect('MLS commit send failed');
            return;
          }
        }
      }
      if (!sendEnvelope(result.bundle.welcome, peer.id)) {
        requestReconnect('MLS welcome send failed');
      }
    },
    [requestReconnect, sendEnvelope],
  );

  const commitPendingAdds = useCallback(async () => {
    if (!isSponsor() || !mlsStateRef.current) return;
    for (const peer of Array.from(pendingAddsRef.current.values())) {
      await commitAdd(peer);
    }
  }, [commitAdd, isSponsor]);

  const commitRemove = useCallback(
    async (peer: PeerEntry) => {
      const state = mlsStateRef.current;
      if (!state) return;
      const leafIndex = leafIndexForIdentity(state, peer.identity);
      if (leafIndex === null) return;
      const result = await removeMember(state, leafIndex);
      mlsStateRef.current = result.state;
      if (!sendEnvelope(result.commit)) {
        requestReconnect('MLS remove send failed');
      }
    },
    [requestReconnect, sendEnvelope],
  );

  const announceNickname = useCallback(async () => {
    const state = mlsStateRef.current;
    const me = myIdRef.current;
    if (!state || !me || !readyRef.current) return;
    try {
      const result = await encryptPayload(state, {
        nickname: nicknameRef.current,
        text: '',
      });
      mlsStateRef.current = result.state;
      if (!sendEnvelope(result.envelope)) {
        requestReconnect('MLS nickname send failed');
      }
    } catch (e) {
      console.warn('MLS nickname announcement failed', e);
      requestReconnect('MLS nickname failed');
    }
  }, [requestReconnect, sendEnvelope]);

  const prunePendingAdds = useCallback(() => {
    const state = mlsStateRef.current;
    if (!state) return;
    for (const [id, peer] of pendingAddsRef.current) {
      if (leafIndexForIdentity(state, peer.identity) !== null) {
        pendingAddsRef.current.delete(id);
      }
    }
  }, []);

  const bootstrapIfAlone = useCallback(async () => {
    const identity = identityRef.current;
    if (!identity || mlsStateRef.current || peersRef.current.size > 0) return;
    mlsStateRef.current = await createInitialGroup(roomId, identity);
    readyRef.current = true;
    connectedOnceRef.current = true;
    clearWelcomeTimer();
    setStatus('connected');
  }, [clearWelcomeTimer, roomId]);

  const processMlsEnvelope = useCallback(
    async (from: string, envelope: string, ts: number) => {
      if (!mlsStateRef.current) {
        pendingWelcomesRef.current.push(envelope);
        await tryJoinPendingWelcome();
        await announceNickname();
        return;
      }
      try {
        const processed = await processEnvelope(mlsStateRef.current, envelope);
        mlsStateRef.current = processed.state;
        prunePendingAdds();
        if (processed.result?.kind === 'app') {
          const payload = processed.result.payload;
          const cleanNick = cleanNickname(payload.nickname) || from.slice(0, 6);
          setNicknames((prev) => ({ ...prev, [from]: cleanNick }));
          if (!payload.text && !payload.image && !payload.replyTo) {
            return;
          }
          pushLine({
            kind: 'msg',
            id: nextLineId(),
            senderId: from,
            nickname: cleanNick,
            text: payload.text,
            ts,
            mine: false,
            replyTo: payload.replyTo,
            image: payload.image,
          });
        }
        await commitPendingAdds();
      } catch (e) {
        console.warn('MLS envelope failed', e);
        requestReconnect('MLS envelope failed');
      }
    },
    [
      announceNickname,
      commitPendingAdds,
      pushLine,
      requestReconnect,
      tryJoinPendingWelcome,
    ],
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
      manualClose = false;
    };

    const scheduleReconnect = (reason?: string) => {
      if (!alive || reconnectTimer !== null) return;
      clearWelcomeTimer();
      readyRef.current = false;
      setStatus('reconnecting');
      if (connectedOnceRef.current && !outageNotified) {
        outageNotified = true;
        pushLine({
          kind: 'system',
          id: nextLineId(),
          text: reason ? `${reason} - reconnecting` : 'disconnected - reconnecting',
        });
      }
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

      offMsg = client.onMessage((msg) => {
        if (!alive) return;
        enqueue(async () => {
          switch (msg.type) {
            case 'joined': {
              const wasReconnecting = connectedOnceRef.current;
              myIdRef.current = msg.your_id;
              setMyId(msg.your_id);
              setNicknames((prev) => ({
                ...prev,
                [msg.your_id]: nicknameRef.current,
              }));
              for (const m of msg.members) {
                const kp = decodeKeyPackage(m.public_key);
                if (!kp) continue;
                if (m.id === msg.your_id) continue;
                peersRef.current.set(m.id, {
                  id: m.id,
                  keyPackage: kp,
                  encodedKeyPackage: m.public_key,
                  identity: identityForKeyPackage(kp),
                });
              }
              refreshRoster();
              await bootstrapIfAlone();
              if (!mlsStateRef.current && peersRef.current.size > 0) {
                armWelcomeTimeout();
              }
              await commitPendingAdds();
              await announceNickname();
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
              if (msg.id === myIdRef.current) return;
              const kp = decodeKeyPackage(msg.public_key);
              if (!kp) return;
              const peer: PeerEntry = {
                id: msg.id,
                keyPackage: kp,
                encodedKeyPackage: msg.public_key,
                identity: identityForKeyPackage(kp),
              };
              peersRef.current.set(msg.id, peer);
              pendingAddsRef.current.set(msg.id, peer);
              refreshRoster();
              if (!mlsStateRef.current) {
                armWelcomeTimeout();
              }
              await commitPendingAdds();
              pushLine({
                kind: 'system',
                id: nextLineId(),
                text: 'someone joined',
              });
              break;
            }
            case 'member_left': {
              if (msg.id === myIdRef.current) return;
              const peer = peersRef.current.get(msg.id);
              peersRef.current.delete(msg.id);
              pendingAddsRef.current.delete(msg.id);
              refreshRoster();
              if (!mlsStateRef.current && peersRef.current.size === 0) {
                await bootstrapIfAlone();
              } else if (!mlsStateRef.current) {
                armWelcomeTimeout();
              }
              if (peer && isSponsor()) {
                await commitRemove(peer);
              }
              await commitPendingAdds();
              pushLine({
                kind: 'system',
                id: nextLineId(),
                text: 'someone left',
              });
              break;
            }
            case 'message': {
              await processMlsEnvelope(msg.from, msg.envelope, msg.ts);
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
        if (manualClose) return;
        scheduleReconnect();
      });

      try {
        const identity = await createMlsIdentity(`member:${crypto.randomUUID()}`);
        if (!alive || clientRef.current !== client) return;
        await queueRef.current;
        if (!alive || clientRef.current !== client) return;
        resetCryptoForJoin(identity);
        await client.connect();
        if (!alive || clientRef.current !== client) return;
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
      clearWelcomeTimer();
      reconnectRef.current = null;
      cleanupClient();
    };
  }, [
    announceNickname,
    bootstrapIfAlone,
    commitPendingAdds,
    commitRemove,
    armWelcomeTimeout,
    clearWelcomeTimer,
    isSponsor,
    processMlsEnvelope,
    pushLine,
    refreshRoster,
    resetCryptoForJoin,
    roomId,
    enqueue,
  ]);

  useEffect(() => {
    const me = myIdRef.current;
    if (me) {
      setNicknames((prev) => ({ ...prev, [me]: cleanNickname(nickname) }));
      enqueue(announceNickname);
    }
  }, [announceNickname, enqueue, nickname]);

  const send = useCallback(
    (
      text: string,
      opts?: { replyTo?: ReplyRef; image?: ImageAttachment },
    ) => {
      enqueue(async () => {
        const state = mlsStateRef.current;
        const me = myIdRef.current;
        if (!state || !me || !readyRef.current) return;
        const trimmed = text.trim();
        if (!trimmed && !opts?.image) return;

        const payload: PlaintextPayload = {
          nickname: nicknameRef.current,
          text: trimmed,
          replyTo: opts?.replyTo,
          image: opts?.image,
        };

        try {
          const result = await encryptPayload(state, payload);
          mlsStateRef.current = result.state;
          const sent = sendEnvelope(result.envelope);
          if (!sent) {
            requestReconnect('send failed');
            return;
          }
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
        } catch (e) {
          console.warn('MLS send failed', e);
          requestReconnect('MLS send failed');
        }
      });
    },
    [enqueue, pushLine, requestReconnect, sendEnvelope],
  );

  return { status, myId, members, nicknames, lines, send };
}
