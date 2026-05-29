import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChatLine } from '../lib/room';
import { colorFor } from '../lib/color';
import { highlight, parseMessage, type MessageSegment } from '../lib/markup';
import type { ImageAttachment } from '../lib/crypto';

interface Props {
  lines: ChatLine[];
  nicknames: Record<string, string>;
  onReply: (line: ChatLine & { kind: 'msg' }) => void;
}

const HOVER_DELAY_MS = 2000;

export function MessageList({ lines, nicknames, onReply }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // Intent-driven autoscroll. `pinned` is the user's stated preference:
  // true = "I want to follow new messages", false = "I'm reading history,
  // don't yank me down". It is updated only when the user actively scrolls.
  // Programmatic scrolling we do ourselves never flips this state.
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const [tooltip, setTooltip] = useState<{ y: number; text: string } | null>(null);
  const [unread, setUnread] = useState(0);
  const prevLineCountRef = useRef(0);
  // Top-padding pushed onto the scroll container so short content sits at
  // the bottom of the viewport. Recomputed whenever totalSize or viewport
  // height changes.
  const [topPad, setTopPad] = useState(0);

  // Track the most recent scrollHeight we observed. When scrollHeight
  // grows on its own (e.g. virtualizer measured a tall row after mount),
  // we want to *not* treat the implied distance-from-bottom change as
  // "user scrolled up". This ref records the height we last saw / set.
  const lastScrollHeightRef = useRef(0);
  const segmentsRef = useRef(
    new Map<string, { text: string; segments: MessageSegment[] }>(),
  );

  const segments = useMemo(() => {
    const cache = segmentsRef.current;
    const active = new Set<string>();
    for (const line of lines) {
      if (line.kind !== 'msg') continue;
      active.add(line.id);
      const cached = cache.get(line.id);
      if (!cached || cached.text !== line.text) {
        cache.set(line.id, {
          text: line.text,
          segments: parseMessage(line.text),
        });
      }
    }
    for (const id of cache.keys()) {
      if (!active.has(id)) cache.delete(id);
    }
    return cache;
  }, [lines]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24,
    overscan: 8,
    getItemKey: (i) => lines[i].id,
  });

  const totalSize = virtualizer.getTotalSize();

  /** Force the container to its very bottom, bypassing intent state. */
  const scrollToBottom = () => {
    const el = parentRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollHeightRef.current = el.scrollHeight;
  };

  // Recalculate top padding so the items hug the bottom edge when short.
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const compute = () => {
      const slack = el.clientHeight - totalSize - 32; // 32 ≈ py-4 vertical
      setTopPad(slack > 0 ? slack : 0);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [totalSize]);

  // Auto-pin: whenever the inner content grows (new line, or virtualizer
  // measured a row to a real height larger than the estimate), if the
  // user wants to be pinned, snap to the new bottom. This is the
  // single mechanism that handles every "should I scroll?" case.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    const el = parentRef.current;
    if (!inner || !el) return;
    const ro = new ResizeObserver(() => {
      // Sync our notion of scrollHeight before deciding what to do; otherwise
      // the next onScroll, which fires synchronously after `scrollTop = ...`,
      // would compute a bogus distance against a stale baseline.
      if (pinnedRef.current) {
        el.scrollTop = el.scrollHeight;
      }
      lastScrollHeightRef.current = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    const lastH = lastScrollHeightRef.current;
    const currH = el.scrollHeight;
    // If scrollHeight just grew (content layout/measure), do NOT update
    // the pinned state from this event — the user didn't move. Update
    // our height baseline and bail. The next user-initiated scroll event
    // will see currH === lastH and proceed normally.
    if (currH !== lastH) {
      lastScrollHeightRef.current = currH;
      return;
    }
    const distance = currH - el.scrollTop - el.clientHeight;
    const atBottom = distance < 24;
    pinnedRef.current = atBottom;
    setPinned(atBottom);
    setTooltip(null);
  };

  // Track new arrivals while scrolled away from the bottom.
  useEffect(() => {
    const prev = prevLineCountRef.current;
    const next = lines.length;
    prevLineCountRef.current = next;
    if (next > prev && !pinned) {
      setUnread((u) => u + (next - prev));
    }
  }, [lines.length, pinned]);

  useEffect(() => {
    if (pinned) setUnread(0);
  }, [pinned]);

  const jumpToBottom = () => {
    pinnedRef.current = true;
    setPinned(true);
    scrollToBottom();
  };

  return (
    <div
      ref={parentRef}
      onScroll={onScroll}
      // min-h-0 is essential: as a flex child this element's default
      // min-height is `auto`, which forbids it from being smaller than its
      // intrinsic content. Without that override the scroll container
      // grows with the message list instead of overflowing into a scroll,
      // which pushes the input row off-screen as new messages arrive.
      className="relative flex-1 min-h-0 overflow-y-auto px-6 py-4 leading-relaxed text-[15px]"
      style={{ paddingTop: 16 + topPad }}
    >
      <div
        ref={innerRef}
        style={{
          height: `${totalSize}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const line = lines[vi.index];
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <Row
                line={line}
                segments={segments.get(line.id)?.segments}
                nicknames={nicknames}
                onReply={onReply}
                onShowTime={(y, text) => setTooltip({ y, text })}
                onClearTime={() => setTooltip(null)}
              />
            </div>
          );
        })}
      </div>
      {tooltip && (
        <div
          className="pointer-events-none fixed text-xs text-neutral-500"
          style={{
            top: tooltip.y,
            right: 8,
            transform: 'translateY(-50%)',
          }}
        >
          {tooltip.text}
        </div>
      )}
      {!pinned && unread > 0 && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-3 right-4 px-3 py-1.5 bg-neutral-800/90 backdrop-blur text-neutral-100 text-xs border border-neutral-700 hover:bg-neutral-700 transition-colors select-none"
          title="jump to latest"
        >
          ↓ {unread} new
        </button>
      )}
    </div>
  );
}

interface RowProps {
  line: ChatLine;
  segments: MessageSegment[] | undefined;
  nicknames: Record<string, string>;
  onReply: (line: ChatLine & { kind: 'msg' }) => void;
  onShowTime: (y: number, text: string) => void;
  onClearTime: () => void;
}

function Row({
  line,
  segments,
  nicknames,
  onReply,
  onShowTime,
  onClearTime,
}: RowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  if (line.kind === 'system') {
    if (line.memberId && line.memberName) {
      return (
        <div className="italic text-neutral-500 py-0.5">
          <span style={{ color: colorFor(line.memberId) }}>
            {line.memberName}
          </span>
          <span> {line.text}</span>
        </div>
      );
    }
    return <div className="italic text-neutral-500 py-0.5">{line.text}</div>;
  }

  const onMouseEnter = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const el = rowRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      onShowTime(y, formatTime(line.ts));
    }, HOVER_DELAY_MS);
  };

  const onMouseLeave = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    onClearTime();
  };

  return (
    <div
      ref={rowRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // mb-1 gives the reply preview below this line breathing room
      // before the next message; py-0.5 keeps the message itself tight.
      // pr-8 reserves space so the absolutely-positioned reply button
      // doesn't visually overlap end-of-line text.
      className="group relative py-0.5 mb-1 pr-8 break-words whitespace-pre-wrap"
    >
      {/* Single text flow: nickname is an inline lead-in, body follows
          inline. When the body wraps, subsequent lines start at the row's
          left edge — they do NOT indent under the nickname. This matters
          because long nicknames would otherwise compress every wrapped
          line into a narrow right column. */}
      <span className="mr-2 select-none" style={{ color: colorFor(line.senderId) }}>
        {line.nickname}
      </span>
      <MessageBody
        segments={segments}
        fallback={line.text}
        nicknames={nicknames}
      />
      {line.image && <InlineImage image={line.image} />}
      <button
        onClick={() => onReply(line)}
        title="reply"
        className="absolute right-0 top-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-xs text-neutral-500 hover:text-neutral-300 select-none"
      >
        ↩
      </button>
      {line.replyTo && (
        <ReplyPreview replyTo={line.replyTo} nicknames={nicknames} />
      )}
    </div>
  );
}

function ReplyPreview({
  replyTo,
  nicknames,
}: {
  replyTo: NonNullable<(ChatLine & { kind: 'msg' })['replyTo']>;
  nicknames: Record<string, string>;
}) {
  const name = nicknames[replyTo.senderId] ?? replyTo.senderId.slice(0, 6);
  return (
    <div className="text-xs text-neutral-500 truncate select-none mt-0.5 pl-4 border-l border-neutral-800">
      <span style={{ color: colorFor(replyTo.senderId) }}>↪ {name}</span>
      <span className="ml-2">{replyTo.preview}</span>
    </div>
  );
}

function InlineImage({ image }: { image: ImageAttachment }) {
  // Cap the inline display to 320px on the longer side so messages don't
  // dominate the column. `block` so the image always sits on its own line
  // beneath any preceding text, regardless of how the text flow wrapped.
  return (
    <img
      src={`data:${image.mime};base64,${image.data}`}
      alt=""
      className="block mt-1 max-h-80 max-w-full"
      style={{ width: 'auto', height: 'auto' }}
    />
  );
}

function MessageBody({
  segments,
  fallback,
  nicknames,
}: {
  segments: MessageSegment[] | undefined;
  fallback: string;
  nicknames: Record<string, string>;
}) {
  if (!segments) {
    return <span className="text-neutral-100">{fallback}</span>;
  }
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return (
            <span key={i} className="text-neutral-100">
              {renderMentions(seg.body, nicknames)}
            </span>
          );
        }
        const html = highlight(seg.body, seg.lang ?? '');
        return (
          <code
            key={i}
            className="hljs block text-neutral-100"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      })}
    </>
  );
}

// Wire form for mentions: `@<full-uuid>`. UUIDs are 36 chars: 8-4-4-4-12 hex.
const MENTION_RE = /@([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;

function renderMentions(
  text: string,
  nicknames: Record<string, string>,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    if (m.index > last) {
      out.push(text.slice(last, m.index));
    }
    const fullId = m[1].toLowerCase();
    const name = nicknames[fullId] ?? fullId.slice(0, 6);
    out.push(
      <span
        key={`m${key++}`}
        style={{ color: colorFor(fullId) }}
        className="select-none"
      >
        @{name}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
