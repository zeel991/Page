'use client';

import { useEffect } from 'react';

/**
 * Weighted, magnetic scrolling for the landing page.
 *
 * Wheel and trackpad input set a target rather than moving the page directly, and
 * the page eases toward it, so scrolling has weight instead of stepping. When the
 * input stops, the page never rests across a section boundary: a boundary in the
 * upper part of the screen pulls the next section up to fill it, and one near the
 * bottom settles the page back to the end of the current section. The direction
 * of travel tips the balance, so a flick carries the reader forward. Inside a long
 * section, with no boundary in view, the page stays where it was left.
 *
 * Only the wheel is taken over. The scrollbar, keyboard, touch and pinch-zoom stay
 * native, and a reader who prefers reduced motion gets ordinary scrolling.
 */

const EASE = 0.1;
const IDLE_MS = 180;
// Where in the viewport a visible boundary tips from "settle back" to "pull forward".
const TIP = { down: 0.7, still: 0.5, up: 0.3 };

export function MagneticScroll({ selector = '[data-snap]' }: { selector?: string }) {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce), (pointer: coarse)').matches) return;

    const root = document.documentElement;
    let target = window.scrollY;
    let current = window.scrollY;
    let raf = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;

    const maxScroll = () => root.scrollHeight - window.innerHeight;
    const clamp = (y: number) => Math.max(0, Math.min(maxScroll(), y));

    const tick = () => {
      current += (target - current) * EASE;
      if (Math.abs(target - current) < 0.5) current = target;
      window.scrollTo(0, current);
      raf = current === target ? 0 : requestAnimationFrame(tick);
    };
    const glide = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };

    let direction: keyof typeof TIP = 'still';

    const snap = () => {
      const h = window.innerHeight;
      const boundary = [...document.querySelectorAll<HTMLElement>(selector)]
        .map((el) => el.getBoundingClientRect().top + window.scrollY)
        .sort((a, b) => a - b)
        .find((top) => top > target + 1 && top < target + h - 1);
      if (boundary === undefined) return;
      const offset = boundary - target;
      target = clamp(offset < h * TIP[direction] ? boundary : boundary - h);
      glide();
    };

    const onWheel = (e: WheelEvent) => {
      // Pinch-zoom arrives as ctrl+wheel, and sideways scrolls belong to whatever
      // scrolls sideways under the cursor.
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      if (!raf) current = window.scrollY;
      target = clamp(target + e.deltaY * unit);
      direction = e.deltaY > 0 ? 'down' : 'up';
      glide();
      clearTimeout(idle);
      idle = setTimeout(snap, IDLE_MS);
    };

    // Anything else that moves the page — the scrollbar, the keyboard, a route
    // change — becomes the new resting point, so the glide never fights it.
    const onScroll = () => {
      if (!raf) target = current = window.scrollY;
      else if (Math.abs(window.scrollY - current) > 2) {
        cancelAnimationFrame(raf);
        raf = 0;
        target = current = window.scrollY;
      }
    };

    // In-page links glide to their section instead of jumping.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"]');
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      const id = a.getAttribute('href')!.slice(1);
      const el = id ? document.getElementById(id) : null;
      if (!el) return;
      e.preventDefault();
      current = window.scrollY;
      target = clamp(el.getBoundingClientRect().top + window.scrollY);
      glide();
      history.replaceState(null, '', `#${id}`);
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('click', onClick);
      cancelAnimationFrame(raf);
      clearTimeout(idle);
    };
  }, [selector]);

  return null;
}
