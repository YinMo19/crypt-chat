import {
  ChangeEvent,
  ClipboardEvent,
  CompositionEvent,
  FormEvent,
  KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { colorFor } from '../lib/color';
import type { ReplyRef, ImageAttachment } from '../lib/crypto';
import type { MemberInfo } from '../lib/ws';
import { compressImage, MAX_IMAGE_SOURCE_BYTES } from '../lib/image';

interface Props {
  onSend: (text: string, opts?: { replyTo?: ReplyRef; image?: ImageAttachment }) => void;
  disabled?: boolean;
  members: MemberInfo[];
  nicknames: Record<string, string>;
  myId: string | null;
  replyTo: ReplyRef | null;
  onClearReply: () => void;
}

const MAX_HEIGHT_PX = 8 * 22;
const MENTION_LIMIT = 8;
/**
 * After an IME composition ends, swallow Enter for this long. Some IMEs
 * (notably macOS Pinyin and certain Android keyboards) fire `keydown.Enter`
 * to commit a candidate WITHOUT setting `isComposing=true`. We can't
 * distinguish "Enter committed a candidate" from "Enter pressed alone" on
 * those keystrokes, so we grace-window the post-composition gap instead.
 */
const IME_GRACE_MS = 80;

interface Candidate {
  id: string;
  nickname: string;
}

export function MessageInput({
  onSend,
  disabled,
  members,
  nicknames,
  myId,
  replyTo,
  onClearReply,
}: Props) {
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // @ menu state
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuQuery, setMenuQuery] = useState('');
  const [menuRange, setMenuRange] = useState<[number, number] | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);

  // Track inserted mentions: token text in textarea -> full member id.
  // We keep this in a ref because it doesn't drive rendering directly;
  // it only matters at submit time to rewrite tokens to wire form.
  const mentionsRef = useRef<Map<string, string>>(new Map());

  // IME composition state. We treat all keys during composition as
  // composition-internal, plus a small grace window after compositionend.
  const composingRef = useRef(false);
  const lastCompositionEndRef = useRef(0);

  // Pending image attachment (compressed). Cleared on send.
  const [pendingImage, setPendingImage] = useState<ImageAttachment | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  /** Return the textarea selection-relative @ menu state. */
  const refreshMenu = (
    text: string,
    selStart: number,
  ): { open: boolean; query: string; range: [number, number] | null } => {
    let i = selStart - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === '@') {
        if (i === 0 || /\s/.test(text[i - 1])) {
          const q = text.slice(i + 1, selStart);
          // Allow letters/digits/_/-/CJK in nickname queries.
          if (/^[\w一-鿿-]*$/.test(q)) {
            return { open: true, query: q, range: [i, selStart] };
          }
        }
        return { open: false, query: '', range: null };
      }
      if (/\s/.test(ch)) break;
      i--;
    }
    return { open: false, query: '', range: null };
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setValue(v);
    const sel = e.target.selectionStart ?? v.length;
    const r = refreshMenu(v, sel);
    setMenuOpen(r.open);
    setMenuQuery(r.query);
    setMenuRange(r.range);
    setMenuIndex(0);

    // Mentions map gets stale when the user backspaces into a token.
    // Lazy GC: drop entries whose token string no longer appears verbatim
    // in the textarea content.
    if (mentionsRef.current.size > 0) {
      for (const token of Array.from(mentionsRef.current.keys())) {
        if (!v.includes(token)) mentionsRef.current.delete(token);
      }
    }
  };

  const candidates: Candidate[] = useMemo(() => {
    if (!menuOpen) return [];
    const q = menuQuery.toLowerCase();
    const all: Candidate[] = members
      .filter((m) => m.id !== myId)
      .map((m) => ({
        id: m.id,
        nickname: nicknames[m.id] ?? m.id.slice(0, 6),
      }));
    return all
      .map((c) => {
        const nick = c.nickname.toLowerCase();
        if (q === '') return { c, score: 0 };
        if (nick.startsWith(q)) return { c, score: 1 };
        if (nick.includes(q)) return { c, score: 2 };
        return { c, score: 99 };
      })
      .filter((r) => r.score < 99 || q === '')
      .sort((a, b) => a.score - b.score)
      .slice(0, MENTION_LIMIT)
      .map((r) => r.c);
  }, [menuOpen, menuQuery, members, nicknames, myId]);

  useEffect(() => {
    if (menuIndex >= candidates.length) setMenuIndex(0);
  }, [candidates, menuIndex]);

  const acceptCandidate = (c: Candidate) => {
    if (!menuRange) return;
    const [a, b] = menuRange;
    // Insert the visible nickname (with leading @) and remember which id
    // it points to. We add a trailing space so the next char doesn't
    // accidentally extend the mention token.
    const token = `@${c.nickname}`;
    const next = value.slice(0, a) + token + ' ' + value.slice(b);
    setValue(next);
    mentionsRef.current.set(token, c.id);
    setMenuOpen(false);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      const pos = a + token.length + 1;
      ta.setSelectionRange(pos, pos);
      ta.focus();
    });
  };

  /** Rewrite visible nickname tokens into wire mentions: @<full-uuid>. */
  const rewriteMentions = (text: string): string => {
    if (mentionsRef.current.size === 0) return text;
    let out = text;
    // Sort by token length DESC so longer tokens replace before shorter
    // ones — guards against `@al` matching when `@alice` is intended.
    const tokens = Array.from(mentionsRef.current.entries()).sort(
      (a, b) => b[0].length - a[0].length,
    );
    for (const [token, id] of tokens) {
      // Replace each occurrence; we don't bother with regex escaping
      // because we control insertion (only nickname chars + leading @).
      out = out.split(token).join(`@${id}`);
    }
    return out;
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = value.replace(/^\s+|\s+$/g, '');
    if (!trimmed && !pendingImage) return;
    const wireText = rewriteMentions(trimmed);
    onSend(wireText, {
      replyTo: replyTo ?? undefined,
      image: pendingImage ?? undefined,
    });
    setValue('');
    mentionsRef.current.clear();
    setPendingImage(null);
    onClearReply();
    setMenuOpen(false);
  };

  /** Are we currently inside an IME composition (or just-finished one)? */
  const isImeActive = (): boolean => {
    if (composingRef.current) return true;
    return Date.now() - lastCompositionEndRef.current < IME_GRACE_MS;
  };

  const onCompositionStart = (_e: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = true;
  };
  const onCompositionEnd = (_e: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    lastCompositionEndRef.current = Date.now();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // While IME is composing OR within the post-composition grace window,
    // treat Enter as IME-internal and never submit. Some IMEs commit a
    // candidate via Enter without setting isComposing on the keydown event,
    // so the grace window is the only reliable signal.
    if (isImeActive() && e.key === 'Enter') {
      // Let the keystroke bubble to the IME; just guarantee we don't submit.
      return;
    }

    if (menuOpen && candidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        acceptCandidate(candidates[menuIndex]);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        acceptCandidate(candidates[menuIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuOpen(false);
        return;
      }
    }
    if (e.key === 'Escape' && replyTo) {
      e.preventDefault();
      onClearReply();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleFile = async (file: File) => {
    setImageError(null);
    if (!file.type.startsWith('image/')) {
      setImageError('not an image');
      return;
    }
    if (file.size > MAX_IMAGE_SOURCE_BYTES) {
      setImageError(`image too large (${(file.size / 1024 / 1024).toFixed(1)} MB > 5 MB)`);
      return;
    }
    try {
      const img = await compressImage(file);
      setPendingImage(img);
    } catch (err) {
      console.error(err);
      setImageError('failed to read image');
    }
  };

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = '';
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) {
          e.preventDefault();
          handleFile(f);
          return;
        }
      }
    }
  };

  return (
    <form onSubmit={submit} className="relative border-t border-neutral-800 px-6 py-3">
      {menuOpen && candidates.length > 0 && (
        <div className="absolute left-6 right-6 bottom-full mb-2 max-h-60 overflow-y-auto bg-neutral-900 border border-neutral-800 text-sm">
          {candidates.map((c, i) => (
            <div
              key={c.id}
              onMouseDown={(ev) => {
                ev.preventDefault();
                acceptCandidate(c);
              }}
              onMouseEnter={() => setMenuIndex(i)}
              className={`px-3 py-1.5 cursor-pointer flex items-center justify-between ${
                i === menuIndex ? 'bg-neutral-800' : ''
              }`}
            >
              <span style={{ color: colorFor(c.id) }}>{c.nickname}</span>
              <span className="text-neutral-600 ml-3 text-xs">{c.id.slice(0, 8)}</span>
            </div>
          ))}
        </div>
      )}
      {pendingImage && (
        <div className="text-xs text-neutral-500 pb-1.5 flex items-center gap-2">
          <img
            src={`data:${pendingImage.mime};base64,${pendingImage.data}`}
            alt=""
            className="h-10 w-auto opacity-90"
          />
          <span>
            {pendingImage.w}×{pendingImage.h} · {Math.round((pendingImage.data.length * 3) / 4 / 1024)} KB
          </span>
          <button
            type="button"
            onClick={() => setPendingImage(null)}
            className="ml-auto text-neutral-600 hover:text-neutral-300"
            title="discard"
          >
            ×
          </button>
        </div>
      )}
      {imageError && (
        <div className="text-xs text-neutral-500 pb-1.5">{imageError}</div>
      )}
      {replyTo && (
        <div className="text-xs text-neutral-500 pb-1.5 flex items-center gap-2">
          <span style={{ color: colorFor(replyTo.senderId) }}>
            ↪ {nicknames[replyTo.senderId] ?? replyTo.senderId.slice(0, 6)}
          </span>
          <span className="truncate flex-1">{replyTo.preview}</span>
          <button
            type="button"
            onClick={onClearReply}
            className="text-neutral-600 hover:text-neutral-300"
            title="cancel reply (esc)"
          >
            ×
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          title="attach image"
          className="text-neutral-500 hover:text-neutral-300 text-base leading-[22px] select-none disabled:opacity-30"
        >
          +
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPickFile}
        />
        <textarea
          ref={taRef}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onPaste={onPaste}
          disabled={disabled}
          autoFocus
          rows={1}
          placeholder="say something  (Enter to send, Shift+Enter for newline, @ to mention)"
          className="block flex-1 resize-none bg-transparent text-[15px] leading-[22px] placeholder:text-neutral-600 disabled:opacity-30"
          maxLength={4000}
        />
      </div>
    </form>
  );
}
