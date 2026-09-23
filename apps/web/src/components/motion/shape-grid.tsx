'use client';

import { useEffect, useRef } from 'react';

/**
 * A hairline square grid whose cells light under the cursor and fade out behind
 * it, after React Bits' ShapeGrid. Purely decorative: it sits behind content and
 * ignores pointer events, listening on its parent instead.
 */
export function ShapeGrid({ cell = 44, line = '#262626', glow = '#f2301b' }: { cell?: number; line?: string; glow?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !host || !ctx) return;

    const heat = new Map<string, number>();
    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      w = host.clientWidth;
      h = host.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const cx = Math.floor((e.clientX - r.left) / cell);
      const cy = Math.floor((e.clientY - r.top) / cell);
      heat.set(`${cx},${cy}`, 1);
    };
    host.addEventListener('pointermove', onMove);

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0.5; x <= w; x += cell) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = 0.5; y <= h; y += cell) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      ctx.fillStyle = glow;
      for (const [key, v] of heat) {
        const [cx, cy] = key.split(',').map(Number) as [number, number];
        ctx.globalAlpha = v * 0.55;
        ctx.fillRect(cx * cell + 1, cy * cell + 1, cell - 1, cell - 1);
        const next = v - 0.025;
        if (next <= 0) heat.delete(key);
        else heat.set(key, next);
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener('pointermove', onMove);
    };
  }, [cell, line, glow]);

  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0" />;
}
