'use client';

import { useRef, type ReactNode } from 'react';

/**
 * Pulls its child toward the cursor when the cursor comes near — the round
 * "Start Now" buttons of the reference design, made tactile.
 */
export function Magnet({ children, strength = 0.35, className = '' }: { children: ReactNode; strength?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || e.pointerType !== 'mouse') return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    el.style.transform = `translate(${dx * strength}px, ${dy * strength}px)`;
  };
  const leave = () => {
    if (ref.current) ref.current.style.transform = '';
  };

  return (
    // The padding widens the field that attracts the cursor beyond the button itself.
    <div className={`-m-8 p-8 ${className}`} onPointerMove={move} onPointerLeave={leave}>
      <div ref={ref} className="transition-transform duration-300 ease-out will-change-transform">
        {children}
      </div>
    </div>
  );
}
