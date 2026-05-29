import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useRoom } from '../lib/room';
import { MessageList } from '../components/MessageList';
import { MessageInput } from '../components/MessageInput';
import type { ChatLine } from '../lib/room';
import type { ReplyRef } from '../lib/crypto';
import { cleanNickname } from '../lib/nickname';
import { isValidRoomId, normalizeRoomId } from '../lib/roomId';

export function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const [nickname] = useState(() =>
    cleanNickname(sessionStorage.getItem('nickname') ?? ''),
  );

  if (!roomId) return <Navigate to="/" replace />;

  // Non-canonical room ids bounce to /r/<normalized>. We don't allow short
  // rooms — see lib/roomId.ts for why. The Navigate is `replace` so the
  // browser back button doesn't bounce back to the un-padded URL.
  if (!isValidRoomId(roomId)) {
    return <Navigate to={`/r/${normalizeRoomId(roomId)}`} replace />;
  }

  // No nickname: redirect to landing with the room id in router state.
  if (!nickname)
    return <Navigate to="/" replace state={{ prefillRoom: roomId }} />;

  return <RoomInner roomId={roomId} nickname={nickname} />;
}

function RoomInner({ roomId, nickname }: { roomId: string; nickname: string }) {
  const { status, lines, members, nicknames, myId, send } = useRoom(
    roomId,
    nickname,
  );
  const [copied, setCopied] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  const copyRoom = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
    } catch {
      /* noop */
    }
  };

  const handleReply = (line: ChatLine & { kind: 'msg' }) => {
    // Build a short preview — strip code fences for a one-line tease.
    const raw = line.text.replace(/```[\s\S]*?```/g, '«code»').replace(/\s+/g, ' ').trim();
    const preview = raw.length > 80 ? raw.slice(0, 77) + '…' : raw;
    setReplyTo({ senderId: line.senderId, preview });
  };

  return (
    // h-full (not min-h-full): cap the column at the viewport so the
    // input row stays anchored at the bottom and the message list scrolls
    // internally instead of pushing the input off-screen.
    <div className="h-full flex flex-col">
      <header className="flex items-baseline justify-between px-6 pt-4 pb-2 text-xs text-neutral-400">
        <div>
          <span className="text-neutral-500">room</span>{' '}
          <button
            onClick={copyRoom}
            className="text-neutral-100 hover:underline"
            title="copy link"
          >
            {roomId}
          </button>
          {copied && <span className="ml-2 text-neutral-500">copied</span>}
        </div>
        <div>
          {status === 'connected' && `${members.length} here`}
          {status === 'connecting' && 'connecting…'}
          {status === 'closed' && 'disconnected'}
        </div>
      </header>

      <MessageList lines={lines} nicknames={nicknames} onReply={handleReply} />
      <MessageInput
        onSend={(text, opts) => send(text, opts)}
        disabled={status !== 'connected'}
        members={members}
        nicknames={nicknames}
        myId={myId}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
      />
    </div>
  );
}
