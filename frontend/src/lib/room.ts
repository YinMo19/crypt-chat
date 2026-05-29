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

export interface RoomState {
  status: 'connecting' | 'connected' | 'closed';
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
  const myIdRef = useRef<string | null>(null);
  const nicknameRef = useRef(cleanNickname(nickname));
  const readyRef = useRef(false);
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

  const sendEnvelope = useCallback((envelope: string, to?: string) => {
    clientRef.current?.send({ type: 'relay', to, envelope });
  }, []);

  const tryJoinPendingWelcome = useCallback(async () => {
    if (mlsStateRef.current || !identityRef.current) return;
    while (pendingWelcomesRef.current.length > 0) {
      const welcome = pendingWelcomesRef.current.shift()!;
      const state = await joinFromWelcome(welcome, identityRef.current);
      if (!state) continue;
      mlsStateRef.current = state;
      readyRef.current = true;
      setStatus('connected');
      return;
    }
  }, []);

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
          sendEnvelope(result.bundle.commit, existing.id);
        }
      }
      sendEnvelope(result.bundle.welcome, peer.id);
    },
    [sendEnvelope],
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
      sendEnvelope(result.commit);
    },
    [sendEnvelope],
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
      sendEnvelope(result.envelope);
    } catch (e) {
      console.warn('MLS nickname announcement failed', e);
    }
  }, [sendEnvelope]);

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
    setStatus('connected');
  }, [roomId]);

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
      }
    },
    [announceNickname, commitPendingAdds, pushLine, tryJoinPendingWelcome],
  );

  useEffect(() => {
    let alive = true;

    const client = new WsClient();
    clientRef.current = client;

    const offMsg = client.onMessage((msg) => {
      if (!alive) return;
      enqueue(async () => {
        switch (msg.type) {
          case 'joined': {
            myIdRef.current = msg.your_id;
            setMyId(msg.your_id);
            setNicknames((prev) => ({
              ...prev,
              [msg.your_id]: nicknameRef.current,
            }));
            for (const m of msg.members) {
              const kp = decodeKeyPackage(m.public_key);
              if (!kp) continue;
              peersRef.current.set(m.id, {
                id: m.id,
                keyPackage: kp,
                encodedKeyPackage: m.public_key,
                identity: identityForKeyPackage(kp),
              });
            }
            refreshRoster();
            await bootstrapIfAlone();
            await commitPendingAdds();
            await announceNickname();
            pushLine({
              kind: 'system',
              id: nextLineId(),
              text: `joined room "${roomId}" - ${msg.members.length + 1} here`,
            });
            break;
          }
          case 'member_joined': {
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
            await commitPendingAdds();
            pushLine({
              kind: 'system',
              id: nextLineId(),
              text: 'someone joined',
            });
            break;
          }
          case 'member_left': {
            const peer = peersRef.current.get(msg.id);
            peersRef.current.delete(msg.id);
            pendingAddsRef.current.delete(msg.id);
            setNicknames((prev) => {
              if (!(msg.id in prev)) return prev;
              const { [msg.id]: _drop, ...rest } = prev;
              return rest;
            });
            refreshRoster();
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

    const offClose = client.onClose(() => {
      if (!alive) return;
      setStatus('closed');
      pushLine({
        kind: 'system',
        id: nextLineId(),
        text: 'disconnected',
      });
    });

    createMlsIdentity(`member:${crypto.randomUUID()}`)
      .then((identity) => {
        if (!alive) return;
        identityRef.current = identity;
        return client.connect().then(() => {
          client.send({
            type: 'join',
            room: roomId,
            public_key: identity.encodedKeyPackage,
          });
        });
      })
      .catch((e) => {
        console.warn('room connect failed', e);
        if (alive) setStatus('closed');
      });

    return () => {
      alive = false;
      offMsg();
      offClose();
      client.close();
    };
  }, [
    announceNickname,
    bootstrapIfAlone,
    commitPendingAdds,
    commitRemove,
    isSponsor,
    processMlsEnvelope,
    pushLine,
    refreshRoster,
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

        try {
          const result = await encryptPayload(state, payload);
          mlsStateRef.current = result.state;
          sendEnvelope(result.envelope);
        } catch (e) {
          console.warn('MLS send failed', e);
        }
      });
    },
    [enqueue, pushLine, sendEnvelope],
  );

  return { status, myId, members, nicknames, lines, send };
}
