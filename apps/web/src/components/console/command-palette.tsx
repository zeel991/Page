'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSurfaceNavigate } from '@/components/transition/surface-transition';
import { CONSOLE_NAV } from './nav';

interface Command {
  label: string;
  hint: string;
  href: string;
  external?: boolean;
}

const COMMANDS: Command[] = [
  ...CONSOLE_NAV.map(([label, href]) => ({ label, hint: 'Go to', href })),
  { label: 'Landing page', hint: 'Go to', href: '/' },
  { label: 'Live worker dashboard', hint: 'Open', href: 'https://pager-developer-worker.onrender.com', external: true },
  { label: 'Demo video', hint: 'Open', href: 'https://youtu.be/2Bos0VkR3jg', external: true },
];

/**
 * ⌘K navigation, after beUI's command palette. Navigation only: this console is
 * read-only, and nothing here can take an action against production.
 */
export function CommandPalette() {
  const navigate = useSurfaceNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? COMMANDS.filter((c) => c.label.toLowerCase().includes(q)) : COMMANDS;
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  const go = (c: Command | undefined) => {
    if (!c) return;
    setOpen(false);
    if (c.external) window.open(c.href, '_blank', 'noreferrer');
    else navigate(c.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') go(results[cursor]);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-3 rounded-full border border-edge bg-panel px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-muted hover:text-text"
      >
        Jump to…
        <kbd className="rounded border border-edge px-1.5 font-mono text-[10px] text-dim">⌘K</kbd>
      </button>

      {/*
        Portalled to <body>: the console header uses backdrop-filter, which makes it
        the containing block for fixed descendants and would clip the overlay to it.
      */}
      {open &&
        createPortal(
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[16vh] backdrop-blur-sm"
          onMouseDown={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="w-full max-w-lg animate-rise overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl [animation-duration:0.35s]"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={onKeyDown}
          >
            <input
              ref={input}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              placeholder="Where to?"
              className="w-full border-b border-edge bg-transparent px-4 py-3.5 text-[14px] text-text outline-none placeholder:text-dim"
            />
            <ul className="max-h-80 overflow-y-auto p-1.5">
              {results.length === 0 && <li className="px-3 py-6 text-center text-[12px] text-dim">No matches.</li>}
              {results.map((c, i) => (
                <li key={c.href}>
                  <button
                    type="button"
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => go(c)}
                    className={`flex w-full items-center justify-between rounded px-3 py-2.5 text-left text-[13px] transition-colors ${i === cursor ? 'bg-panel-2 text-text' : 'text-muted'}`}
                  >
                    <span className="flex items-center gap-3">
                      <span className={`h-3.5 w-[3px] rounded-full ${i === cursor ? 'bg-signal' : 'bg-transparent'}`} />
                      {c.label}
                    </span>
                    <span className="font-mono text-[10px] text-dim">
                      {c.hint}
                      {c.external ? ' ↗' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex gap-4 border-t border-edge px-4 py-2 font-mono text-[10px] text-dim">
              <span>↑↓ move</span>
              <span>↵ open</span>
              <span>esc close</span>
            </div>
          </div>
        </div>,
          document.body,
        )}
    </>
  );
}
