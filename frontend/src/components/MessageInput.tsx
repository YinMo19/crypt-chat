import {
  ChangeEvent,
  ClipboardEvent,
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
  onSend: (
    text: string,
    opts?: { replyTo?: ReplyRef; image?: ImageAttachment },
  ) => Promise<boolean>;
  disabled?: boolean;
  members: MemberInfo[];
  nicknames: Record<string, string>;
  myId: string | null;
  replyTo: ReplyRef | null;
  onClearReply: () => void;
}

const MAX_HEIGHT_PX = 8 * 22;
const MENTION_LIMIT = 8;
/** Per-message text size cap. 64 KiB = a full long source file. */
const MAX_TEXT_CHARS = 64 * 1024;
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

interface MentionSpan {
  start: number;
  end: number;
  token: string;
  id: string;
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

  // Track inserted mentions by range, not just token text. This keeps two
  // users with the same nickname, or hand-typed `@nick`, from being rewritten
  // to the wrong id at submit time.
  // We keep this in a ref because it doesn't drive rendering directly;
  // it only matters at submit time to rewrite tokens to wire form.
  const mentionsRef = useRef<MentionSpan[]>([]);

  // IME composition state. We treat all keys during composition as
  // composition-internal, plus a small grace window after compositionend.
  const composingRef = useRef(false);
  const lastCompositionEndRef = useRef(0);

  // Pending image attachment (compressed). Cleared on send.
  const [pendingImage, setPendingImage] = useState<ImageAttachment | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

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
    const at = text.lastIndexOf('@', selStart - 1);
    if (at >= 0 && (at === 0 || /\s/.test(text[at - 1]))) {
      const q = text.slice(at + 1, selStart);
      // Match the nickname alphabet: letters, digits, space, `_`, `#`.
      if (/^[A-Za-z0-9 _#]*$/.test(q)) {
        return { open: true, query: q, range: [at, selStart] };
      }
    }
    return { open: false, query: '', range: null };
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setSendError(null);
    mentionsRef.current = adjustMentionSpans(mentionsRef.current, value, v);
    setValue(v);
    const sel = e.target.selectionStart ?? v.length;
    const r = refreshMenu(v, sel);
    setMenuOpen(r.open);
    setMenuQuery(r.query);
    setMenuRange(r.range);
    setMenuIndex(0);
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
    mentionsRef.current = adjustMentionSpans(mentionsRef.current, value, next);
    mentionsRef.current.push({
      start: a,
      end: a + token.length,
      token,
      id: c.id,
    });
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
    if (mentionsRef.current.length === 0) return text;
    const leadingTrim = value.length - value.trimStart().length;
    const spans = mentionsRef.current
      .map((span) => ({
        ...span,
        start: span.start - leadingTrim,
        end: span.end - leadingTrim,
      }))
      .filter(
        (span) =>
          span.start >= 0 &&
          span.end <= text.length &&
          text.slice(span.start, span.end) === span.token,
      )
      .sort((a, b) => a.start - b.start);
    if (spans.length === 0) return text;
    let out = '';
    let pos = 0;
    for (const span of spans) {
      out += text.slice(pos, span.start);
      out += `@${span.id}`;
      pos = span.end;
    }
    return out + text.slice(pos);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (sending) return;
    const trimmed = value.replace(/^\s+|\s+$/g, '');
    if (!trimmed && !pendingImage) return;
    const wireText = rewriteMentions(trimmed);
    setSending(true);
    setSendError(null);
    const sent = await onSend(wireText, {
      replyTo: replyTo ?? undefined,
      image: pendingImage ?? undefined,
    });
    setSending(false);
    if (sent) {
      setValue('');
      mentionsRef.current = [];
      setPendingImage(null);
      onClearReply();
      setMenuOpen(false);
    } else {
      setSendError('send failed, message kept');
    }
    requestAnimationFrame(() => taRef.current?.focus());
  };

  /** Are we currently inside an IME composition (or just-finished one)? */
  const isImeActive = (): boolean => {
    if (composingRef.current) return true;
    return Date.now() - lastCompositionEndRef.current < IME_GRACE_MS;
  };

  const onCompositionStart = () => {
    composingRef.current = true;
  };
  const onCompositionEnd = () => {
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
      const sizeMb = (file.size / 1024 / 1024).toFixed(1);
      const maxMb = Math.round(MAX_IMAGE_SOURCE_BYTES / 1024 / 1024);
      setImageError(`image too large (${sizeMb} MB > ${maxMb} MB)`);
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
      {(imageError || sendError) && (
        <div className="text-xs text-neutral-500 pb-1.5">
          {imageError ?? sendError}
        </div>
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
          disabled={disabled || sending}
          autoFocus
          rows={1}
          placeholder={sending ? 'sending...' : 'say something  (Enter to send, Shift+Enter for newline, @ to mention)'}
          className="block flex-1 resize-none bg-transparent text-[15px] leading-[22px] placeholder:text-neutral-600 disabled:opacity-30"
          // 64 KiB. The HTML `maxLength` attribute is a hard truncation
          // applied even on paste, so we set it large enough to fit a full
          // source file. The server frame cap is much higher (6 MiB) and
          // accommodates this plus a co-attached image with room to spare.
          maxLength={MAX_TEXT_CHARS}
        />
      </div>
    </form>
  );
}

function adjustMentionSpans(
  spans: MentionSpan[],
  before: string,
  after: string,
): MentionSpan[] {
  if (spans.length === 0) return spans;
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    start++;
  }
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd--;
    afterEnd--;
  }
  const delta = afterEnd - beforeEnd;
  const next: MentionSpan[] = [];
  for (const span of spans) {
    if (span.end <= start) {
      next.push(span);
    } else if (span.start >= beforeEnd) {
      next.push({ ...span, start: span.start + delta, end: span.end + delta });
    }
  }
  return next.filter((span) => after.slice(span.start, span.end) === span.token);
}
