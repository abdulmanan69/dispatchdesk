import { Children, Fragment, forwardRef, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';

const cx = (...c) => c.filter(Boolean).join(' ');
const HAS_WIDTH = /(^|\s)(sm:|md:|lg:)?(w-|min-w-|flex-1|basis-)/;

/** Plain text of option children (for typeahead, search and the trigger label). */
function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf(node.props.children);
  return '';
}

/** Read <option>/<optgroup> children (fragments, arrays and conditionals allowed) into a flat list. */
function readOptions(children, group = null, out = []) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) return readOptions(child.props.children, group, out);
    if (child.type === 'optgroup') return readOptions(child.props.children, child.props.label, out);
    if (child.type === 'option') {
      const label = child.props.children;
      const value = child.props.value !== undefined ? String(child.props.value) : textOf(label);
      out.push({ value, label: label ?? value, text: textOf(label) || value, disabled: !!child.props.disabled, group });
    }
  });
  return out;
}

/** Fixed-position popover anchored to an element; flips above when there is no room below. */
function usePopoverPosition(anchorRef, open, maxHeight = 288) {
  const [pos, setPos] = useState(null);
  const update = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < Math.min(maxHeight, 200) && above > below;
    const width = Math.max(r.width, 176);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    setPos({ left, width, top: up ? undefined : r.bottom + 4, bottom: up ? window.innerHeight - r.top + 4 : undefined, maxHeight: Math.max(120, Math.min(maxHeight, up ? above : below)) });
  }, [anchorRef, maxHeight]);
  useLayoutEffect(() => {
    if (!open) return undefined;
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open, update]);
  return pos;
}

function useOutside(open, refs, onOutside) {
  useEffect(() => {
    if (!open) return undefined;
    const fn = (e) => { if (!refs.some((r) => r.current?.contains(e.target))) onOutside(); };
    document.addEventListener('pointerdown', fn, true);
    return () => document.removeEventListener('pointerdown', fn, true);
  }, [open, refs, onOutside]);
}

const panel = 'dd-pop fixed z-[1000] overflow-hidden rounded-lg border border-line-strong bg-surface shadow-lg shadow-black/10';
const optionCls = (active, selected, disabled) => cx(
  'flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm',
  disabled ? 'cursor-not-allowed opacity-40' : active ? 'bg-surface-2 text-fg' : 'text-fg-2',
  selected && 'text-fg',
);

/**
 * Themed dropdown with the same API as a native <select>: value/defaultValue, onChange(e) with e.target.value,
 * name (submitted through a hidden input), disabled, id/aria-label, and <option>/<optgroup> children.
 */
export const Select = forwardRef(function Select({
  className, children, value, defaultValue, onChange, name, disabled, id, required, onClick, onKeyDown, placeholder, searchable, ...rest
}, ref) {
  const options = useMemo(() => readOptions(children), [children]);
  const controlled = value !== undefined;
  const [inner, setInner] = useState(() => (defaultValue !== undefined ? String(defaultValue) : options[0]?.value ?? ''));
  const current = controlled ? (value == null ? '' : String(value)) : inner;
  const selected = options.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState('');
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const listId = `${useId()}-list`;
  const typeahead = useRef({ text: '', t: 0 });
  const showSearch = searchable ?? options.length > 12;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.text.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const pos = usePopoverPosition(btnRef, open);

  const setRefs = (el) => { btnRef.current = el; if (typeof ref === 'function') ref(el); else if (ref) ref.current = el; };
  const close = useCallback((focus = true) => { setOpen(false); setQuery(''); if (focus) btnRef.current?.focus(); }, []);
  useOutside(open, [btnRef, popRef], useCallback(() => close(false), [close]));

  const choose = (o) => {
    if (!o || o.disabled) return;
    if (!controlled) setInner(o.value);
    if (o.value !== current) onChange?.({ target: { value: o.value, name, type: 'select-one', id }, currentTarget: { value: o.value, name } });
    close();
  };
  const openList = () => {
    if (disabled) return;
    setOpen(true);
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
  };
  useEffect(() => {
    if (!open) return;
    const el = popRef.current?.querySelector(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);
  useEffect(() => { if (open) setActive(visible.length ? 0 : -1); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (dir) => {
    if (!visible.length) return;
    let i = active;
    for (let n = 0; n < visible.length; n++) {
      i = (i + dir + visible.length) % visible.length;
      if (!visible[i].disabled) break;
    }
    setActive(i);
  };
  const key = (e) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openList(); return; }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Typeahead on the closed control, like a native select.
        const now = Date.now();
        const ta = typeahead.current;
        ta.text = now - ta.t > 700 ? e.key.toLowerCase() : ta.text + e.key.toLowerCase();
        ta.t = now;
        const hit = options.find((o) => !o.disabled && o.text.toLowerCase().startsWith(ta.text));
        if (hit) choose(hit);
      }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(visible.length - 1); }
    else if (e.key === 'Enter' || (e.key === ' ' && !showSearch)) { e.preventDefault(); choose(visible[active]); }
    else if (e.key === 'Tab') close(false);
  };

  const empty = !selected || selected.value === '';
  let lastGroup = null;
  return (
    <>
      <button
        ref={setRefs} id={id} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-required={required || undefined} disabled={disabled}
        className={cx(
          'flex h-9 items-center justify-between gap-2 rounded-lg border border-line-strong bg-surface pl-3 pr-2 text-left text-sm text-fg transition-ui',
          'hover:border-fg-2/40 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/15 disabled:cursor-not-allowed disabled:opacity-60',
          open && 'border-brand-500 ring-2 ring-brand-500/15',
          HAS_WIDTH.test(className || '') ? '' : 'w-full', className,
        )}
        onClick={(e) => { onClick?.(e); if (!e.defaultPrevented) (open ? close() : openList()); }}
        onKeyDown={key}
        {...rest}
      >
        <span className={cx('min-w-0 flex-1 truncate', empty && 'text-muted')}>{selected ? selected.label : placeholder || 'Select'}</span>
        <ChevronDown className={cx('size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {name && <input type="hidden" name={name} value={current} />}
      {open && pos && createPortal(
        <div ref={popRef} className={panel} style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width }} onKeyDown={key}
          onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          {showSearch && (
            <div className="flex items-center gap-2 border-b border-line px-2.5">
              <Search className="size-3.5 shrink-0 text-muted" aria-hidden />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search options"
                className="h-9 w-full bg-transparent text-sm text-fg placeholder:text-muted focus:outline-none" />
            </div>
          )}
          <ul id={listId} role="listbox" tabIndex={-1} aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            className="overflow-y-auto p-1" style={{ maxHeight: pos.maxHeight - (showSearch ? 37 : 0) }}>
            {visible.length === 0 && <li className="px-2.5 py-2 text-sm text-muted">No matches</li>}
            {visible.map((o, i) => {
              const header = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              const isSel = o.value === current;
              return (
                <Fragment key={`${o.group || ''}:${o.value}:${i}`}>
                  {header && <li role="presentation" className="px-2.5 pb-1 pt-2 text-[11.5px] font-medium text-muted">{header}</li>}
                  <li id={`${listId}-${i}`} data-index={i} role="option" aria-selected={isSel} aria-disabled={o.disabled || undefined}
                    className={optionCls(i === active, isSel, o.disabled)}
                    onPointerMove={() => !o.disabled && setActive(i)} onClick={() => choose(o)}>
                    <span className={cx('min-w-0 flex-1 truncate', o.value === '' && 'text-muted')}>{o.label}</span>
                    {isSel && <Check className="size-4 shrink-0 text-brand-600" aria-hidden />}
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
});

/**
 * Text field with a themed suggestions list: pick a preset or type your own.
 * options: string[] | { value, label }[]. onChange receives { target: { value, name } } like an input event.
 */
export const ComboInput = forwardRef(function ComboInput({ options = [], className, id, value, onChange, onKeyDown, onFocus, name, type, disabled, ...props }, ref) {
  const opts = useMemo(() => options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)), [options]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [typed, setTyped] = useState(false);
  const inputRef = useRef(null);
  const popRef = useRef(null);
  const wrapRef = useRef(null);
  const listId = `${useId()}-list`;
  const text = value == null ? '' : String(value);
  const visible = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!typed || !q) return opts;
    return opts.filter((o) => String(o.label).toLowerCase().includes(q) || String(o.value).toLowerCase().includes(q));
  }, [opts, text, typed]);
  const pos = usePopoverPosition(wrapRef, open && visible.length > 0, 240);
  useOutside(open, [wrapRef, popRef], useCallback(() => setOpen(false), []));
  const setRefs = (el) => { inputRef.current = el; if (typeof ref === 'function') ref(el); else if (ref) ref.current = el; };
  const emit = (v) => onChange?.({ target: { value: v, name, type: type || 'text', id }, currentTarget: { value: v, name } });
  const pick = (o) => { emit(String(o.value)); setOpen(false); setTyped(false); inputRef.current?.focus(); };
  const key = (e) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) { setOpen(true); setActive(0); } else setActive((a) => Math.min(visible.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp' && open) { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && open && active >= 0 && visible[active]) { e.preventDefault(); pick(visible[active]); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === 'Tab') setOpen(false);
  };
  return (
    <div ref={wrapRef} className={cx('relative', HAS_WIDTH.test(className || '') ? className : 'w-full')}>
      <input
        ref={setRefs} id={id} name={name} type={type} value={value} disabled={disabled} autoComplete="off"
        role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined}
        className={cx('h-9 w-full rounded-lg border border-line-strong bg-surface pl-3 pr-8 text-sm text-fg placeholder:text-muted transition-ui focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/15 disabled:opacity-60', HAS_WIDTH.test(className || '') ? '' : className)}
        onChange={(e) => { setTyped(true); setOpen(true); setActive(-1); onChange?.(e); }}
        onFocus={(e) => { onFocus?.(e); }}
        onKeyDown={key}
        {...props}
      />
      <button type="button" tabIndex={-1} aria-label="Show suggestions" disabled={disabled}
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted hover:text-fg"
        onClick={() => { setTyped(false); setOpen((o) => !o); setActive(-1); inputRef.current?.focus(); }}>
        <ChevronDown className={cx('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && pos && visible.length > 0 && createPortal(
        <ul ref={popRef} id={listId} role="listbox" className={cx(panel, 'overflow-y-auto p-1')}
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }}
          onClick={(e) => e.stopPropagation()}>
          {visible.map((o, i) => (
            <li key={`${o.value}:${i}`} role="option" aria-selected={String(o.value) === text}
              className={optionCls(i === active, String(o.value) === text, false)}
              onPointerMove={() => setActive(i)} onPointerDown={(e) => e.preventDefault()} onClick={() => pick(o)}>
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {String(o.value) === text && <Check className="size-4 shrink-0 text-brand-600" aria-hidden />}
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
});
