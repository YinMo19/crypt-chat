import { FormEvent, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { newRoomId, normalizeRoomId, ROOM_ID_LENGTH } from '../lib/roomId';

export function Landing() {
  const navigate = useNavigate();
  const location = useLocation();
  // When redirected back from /r/:roomId without a nickname, the route
  // passes the original room id along so we can pre-fill the form.
  const prefill =
    (location.state as { prefillRoom?: string } | null)?.prefillRoom ?? '';
  const [nickname, setNickname] = useState(() => sessionStorage.getItem('nickname') ?? '');
  const [roomId, setRoomId] = useState(prefill);

  const enter = (e: FormEvent) => {
    e.preventDefault();
    const nick = nickname.trim();
    if (!nick) return;
    sessionStorage.setItem('nickname', nick);
    const trimmed = roomId.trim();
    const room = trimmed ? normalizeRoomId(trimmed) : newRoomId();
    navigate(`/r/${encodeURIComponent(room)}`);
  };

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <form onSubmit={enter} className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl tracking-tight">crypt-chat</h1>
          <p className="text-sm text-neutral-400">
            ephemeral end-to-end encrypted rooms. server can't read anything.
          </p>
        </div>

        <label className="block">
          <span className="text-xs uppercase tracking-wider text-neutral-400">nickname</span>
          <input
            autoFocus
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            className="mt-1 w-full border-b border-neutral-700 bg-transparent py-1 text-base focus:border-neutral-100"
            placeholder="anonymous"
            maxLength={32}
          />
        </label>

        <label className="block">
          <span className="text-xs uppercase tracking-wider text-neutral-400">
            room id (blank = new room)
          </span>
          <input
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            className="mt-1 w-full border-b border-neutral-700 bg-transparent py-1 text-base focus:border-neutral-100"
            placeholder={`e.g. ${ROOM_ID_LENGTH}-char id`}
            maxLength={64}
          />
        </label>

        <button
          type="submit"
          className="w-full border border-neutral-100 py-2 text-sm tracking-wider hover:bg-neutral-100 hover:text-neutral-900 transition-colors disabled:opacity-30"
          disabled={!nickname.trim()}
        >
          enter
        </button>
      </form>
    </div>
  );
}
