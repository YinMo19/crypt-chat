import type { KeyPackage } from 'ts-mls';
import type { ImageAttachment, ReplyRef } from '../crypto';
import type { MemberInfo } from '../ws';

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
  | {
      kind: 'system';
      id: string;
      text: string;
      memberId?: string;
      memberName?: string;
    };

export interface PeerEntry {
  id: string;
  keyPackage: KeyPackage;
  encodedKeyPackage: string;
  identity: string;
}

export interface RoomState {
  status: 'connecting' | 'connected' | 'reconnecting' | 'closed';
  wsConnected: boolean;
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
  ) => Promise<boolean>;
}
