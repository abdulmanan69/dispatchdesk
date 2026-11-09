import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { Avatar, Button, Textarea, cx } from '../ui.jsx';
import { dateTime } from '../../lib/format.js';

/**
 * Message list + composer. `mineKey(m)` decides alignment.
 * onSend(body) must return a promise; composer clears on success.
 */
export function ChatThread({ messages, mine, onSend, sending, placeholder = 'Write a message…', emptyText }) {
  const [body, setBody] = useState('');
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages?.length]);

  const submit = async (e) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    try { await onSend(text); setBody(''); } catch { /* toast shown by caller */ }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {!messages?.length && <p className="py-10 text-center text-sm text-muted">{emptyText}</p>}
        {messages?.map((m) => {
          const own = mine(m);
          return (
            <div key={m.id} className={cx('flex items-end gap-2', own && 'flex-row-reverse')}>
              <Avatar name={m.author?.name || m.sender?.name || '?'} src={m.author?.avatarUrl || m.sender?.avatarUrl} size={26} />
              <div className={cx('max-w-[78%] rounded-lg px-3 py-2 text-sm', own ? 'bg-brand-600 text-white' : 'border border-line bg-surface-2')}>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className={cx('mt-1 text-[10.5px]', own ? 'text-white/70' : 'text-muted')}>
                  {(m.author?.name || m.sender?.name) && !own ? `${m.author?.name || m.sender?.name} · ` : ''}{dateTime(m.createdAt)}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {onSend && (
        <form onSubmit={submit} className="flex items-end gap-2 border-t border-line p-3">
          <Textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={placeholder} aria-label="Message" maxLength={4000}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e); }} />
          <Button type="submit" icon={Send} loading={sending} disabled={!body.trim()}>Send</Button>
        </form>
      )}
    </div>
  );
}
