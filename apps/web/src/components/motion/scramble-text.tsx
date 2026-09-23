'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=<>/_';

/**
 * Text that decrypts itself left to right — on first view, and again on hover.
 *
 * Renders the real text on the server and to assistive technology; only the
 * visible glyphs scramble.
 */
export function ScrambleText({ text, className = '', speed = 28 }: { text: string; className?: string; speed?: number }) {
  const [shown, setShown] = useState(text);
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const run = useCallback(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (timer.current) clearInterval(timer.current);
    let frame = 0;
    timer.current = setInterval(() => {
      frame++;
      const settled = Math.floor(frame / 2);
      setShown(
        text
          .split('')
          .map((ch, i) => (ch === ' ' || i < settled ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]))
          .join(''),
      );
      if (settled >= text.length && timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    }, speed);
  }, [text, speed]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        io.disconnect();
        run();
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer.current) clearInterval(timer.current);
    };
  }, [run]);

  return (
    <span ref={ref} className={className} onMouseEnter={run} aria-label={text}>
      <span aria-hidden>{shown}</span>
    </span>
  );
}
