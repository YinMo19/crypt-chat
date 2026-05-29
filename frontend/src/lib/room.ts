/**
 * Room state hook.
 *
 * Sender Keys protocol (see lib/crypto.ts for wire format) — extended:
 *
 *   Frame kinds in flight:
 *     KEY  : wrap-and-deliver our sender key to one peer (ECDH+HKDF KEK)
 *     MSG  : a chat message under our sender key
 *     NICK : announce our nickname under our sender key
 *
 *   On join:
 *     1. Generate keypair + sender key + nonce salt.
 *     2. Send `join`, wait for `joined` (with roster).
 *     3. For each existing peer: send a KEY frame addressed to them.
 *     4. Broadcast a NICK frame (so everyone, including future joiners
 *        whose `KEY` from us they receive, can resolve our id → name).
 *
 *   On `member_joined`:
 *     - Send our KEY directly to them.
 *     - Send our NICK directly to them. (Saves them from waiting for our
 *       next chat message before they can render us in the @ list.)
 *
 *   On incoming `message`:
 *     - kind=KEY  : unwrap and store peer.senderKey
 *     - kind=MSG  : decrypt with peer.senderKey, push line with server ts
 *     - kind=NICK : decrypt with peer.senderKey, store nicknames[from]
 *
 *   On send(text, replyTo?):
 *     - One AES-GCM encrypt with our sender key + counter — O(1).
 *     - Echo to our own UI immediately.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ImageAttachment,
  KeyPair,
  PlaintextPayload,
  ReplyRef,
  b64decode,
  b64encode,
  buildKeyFrame,
  buildMsgFrame,
  buildNickFrame,
  FRAME_KIND_KEY,
  FRAME_KIND_MSG,
  FRAME_KIND_NICK,
  frameKind,
  generateKeyPair,
  generateSenderKey,
  openKeyFrame,
  openMsgFrame,
  openNickFrame,
} from './crypto';
import { randomBytes } from '@noble/hashes/utils';
import { WsClient, type MemberInfo } from './ws';

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
  publicKey: Uint8Array;
  senderKey: Uint8Array | null;
}

let lineCounter = 0;
const nextLineId = () => `${Date.now()}-${lineCounter++}`;

export interface RoomState {
  status: 'connecting' | 'connected' | 'closed';
  myId: string | null;
  /** Full roster including me. Stable across re-renders only when the set
   * of ids changes; consumers should treat the array as immutable. */
  members: MemberInfo[];
  /** id → nickname map. Self always present. */
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

  const keypairRef = useRef<KeyPair | null>(null);
  const senderKeyRef = useRef<Uint8Array | null>(null);
  const nonceSaltRef = useRef<Uint8Array | null>(null);
  const counterRef = useRef<bigint>(0n);
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const clientRef = useRef<WsClient | null>(null);
  const myIdRef = useRef<string | null>(null);
  const nicknameRef = useRef(nickname);

  useEffect(() => {
    nicknameRef.current = nickname;
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
    const out: MemberInfo[] = [];
    if (me) {
      const meKp = keypairRef.current;
      if (meKp) out.push({ id: me, public_key: b64encode(meKp.publicKey) });
    }
    for (const peer of peersRef.current.values()) {
      out.push({ id: peer.id, public_key: b64encode(peer.publicKey) });
    }
    setMembers(out);
  }, []);

  /** Send our sender key to a single peer (KEY frame). */
  const sendKeyTo = useCallback((peer: PeerEntry) => {
    const client = clientRef.current;
    const kp = keypairRef.current;
    const sk = senderKeyRef.current;
    if (!client || !kp || !sk) return;
    const envelope = buildKeyFrame(kp.privateKey, peer.publicKey, sk);
    client.send({ type: 'relay', to: peer.id, envelope });
  }, []);

  /** Build and send a NICK frame. With `to` it unicasts; without, broadcasts. */
  const sendNick = useCallback((to?: string) => {
    const client = clientRef.current;
    const sk = senderKeyRef.current;
    const salt = nonceSaltRef.current;
    if (!client || !sk || !salt) return;
    const counter = counterRef.current;
    counterRef.current = counter + 1n;
    const envelope = buildNickFrame(sk, salt, counter, nicknameRef.current);
    client.send({ type: 'relay', to, envelope });
  }, []);

  useEffect(() => {
    let alive = true;
    const kp = generateKeyPair();
    const sk = generateSenderKey();
    const salt = randomBytes(4);
    keypairRef.current = kp;
    senderKeyRef.current = sk;
    nonceSaltRef.current = salt;
    counterRef.current = 0n;

    const client = new WsClient();
    clientRef.current = client;

    const offMsg = client.onMessage((msg) => {
      if (!alive) return;
      switch (msg.type) {
        case 'joined': {
          myIdRef.current = msg.your_id;
          setMyId(msg.your_id);
          // Self into nickname map.
          setNicknames((prev) => ({ ...prev, [msg.your_id]: nicknameRef.current }));
          for (const m of msg.members) {
            const peer: PeerEntry = {
              id: m.id,
              publicKey: b64decode(m.public_key),
              senderKey: null,
            };
            peersRef.current.set(m.id, peer);
            // Distribute our sender key to each existing peer.
            sendKeyTo(peer);
          }
          // Announce our nickname to the room. Existing peers will be able
          // to decrypt this once their `KEY` from us above has landed.
          // (KEY is sent before NICK in the same task tick, and the server
          // preserves order on a single connection.)
          sendNick();
          refreshRoster();
          setStatus('connected');
          pushLine({
            kind: 'system',
            id: nextLineId(),
            text: `joined room "${roomId}" — ${msg.members.length + 1} here`,
          });
          break;
        }
        case 'member_joined': {
          const peer: PeerEntry = {
            id: msg.id,
            publicKey: b64decode(msg.public_key),
            senderKey: null,
          };
          peersRef.current.set(msg.id, peer);
          // New peer needs both our key and our nickname.
          sendKeyTo(peer);
          sendNick(msg.id);
          refreshRoster();
          pushLine({
            kind: 'system',
            id: nextLineId(),
            text: 'someone joined',
          });
          break;
        }
        case 'member_left': {
          peersRef.current.delete(msg.id);
          // Drop their nickname so the @ list stays accurate.
          setNicknames((prev) => {
            if (!(msg.id in prev)) return prev;
            const { [msg.id]: _drop, ...rest } = prev;
            return rest;
          });
          refreshRoster();
          pushLine({
            kind: 'system',
            id: nextLineId(),
            text: 'someone left',
          });
          break;
        }
        case 'message': {
          const peer = peersRef.current.get(msg.from);
          if (!peer || !keypairRef.current) return;
          const kind = frameKind(msg.envelope);
          if (kind === FRAME_KIND_KEY) {
            const newKey = openKeyFrame(
              keypairRef.current.privateKey,
              peer.publicKey,
              msg.envelope,
            );
            if (newKey) peer.senderKey = newKey;
            return;
          }
          if (!peer.senderKey) {
            // Their KEY hasn't arrived yet — drop and rely on retry.
            return;
          }
          if (kind === FRAME_KIND_NICK) {
            const nick = openNickFrame(peer.senderKey, msg.envelope);
            if (nick) {
              setNicknames((prev) => ({ ...prev, [msg.from]: nick }));
            }
            return;
          }
          if (kind === FRAME_KIND_MSG) {
            const payload = openMsgFrame(peer.senderKey, msg.envelope);
            if (!payload) return;
            pushLine({
              kind: 'msg',
              id: nextLineId(),
              senderId: msg.from,
              nickname: payload.nickname,
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

    const offClose = client.onClose(() => {
      if (!alive) return;
      setStatus('closed');
      pushLine({
        kind: 'system',
        id: nextLineId(),
        text: 'disconnected',
      });
    });

    client
      .connect()
      .then(() => {
        client.send({
          type: 'join',
          room: roomId,
          public_key: b64encode(kp.publicKey),
        });
      })
      .catch(() => {
        if (alive) setStatus('closed');
      });

    return () => {
      alive = false;
      offMsg();
      offClose();
      client.close();
    };
  }, [roomId, pushLine, refreshRoster, sendKeyTo, sendNick]);

  // If our nickname changed mid-session, broadcast it again.
  useEffect(() => {
    if (status === 'connected') {
      sendNick();
      const me = myIdRef.current;
      if (me) {
        setNicknames((prev) => ({ ...prev, [me]: nickname }));
      }
    }
    // Only re-fire on actual nickname change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nickname]);

  const send = useCallback(
    (
      text: string,
      opts?: { replyTo?: ReplyRef; image?: ImageAttachment },
    ) => {
      const client = clientRef.current;
      const sk = senderKeyRef.current;
      const salt = nonceSaltRef.current;
      const me = myIdRef.current;
      if (!client || !sk || !salt || !me) return;
      const trimmed = text.trim();
      if (!trimmed && !opts?.image) return;

      const payload: PlaintextPayload = {
        nickname: nicknameRef.current,
        text: trimmed,
        replyTo: opts?.replyTo,
        image: opts?.image,
      };

      // Local echo. Server timestamp will be very close to this for peers.
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

      const counter = counterRef.current;
      counterRef.current = counter + 1n;
      const envelope = buildMsgFrame(sk, salt, counter, payload);
      client.send({ type: 'relay', envelope });
    },
    [pushLine],
  );

  return { status, myId, members, nicknames, lines, send };
}
