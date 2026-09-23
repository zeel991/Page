'use client';

import { useEffect, useMemo, useRef } from 'react';

/**
 * One-bit ordered dithering, after the halftone imagery in the reference design.
 *
 * A scene is drawn in greyscale onto a small offscreen canvas, thresholded against
 * an 8×8 Bayer matrix, and scaled up with nearest-neighbour sampling so each source
 * pixel stays a crisp square. Animation runs only while the canvas is on screen,
 * and renders a single frame when the reader prefers reduced motion.
 */

const BAYER_8 = (() => {
  const m = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
  ];
  return m.map((row) => row.map((v) => (v + 0.5) / 64));
})();

type Scene = (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function useDither(
  ref: React.RefObject<HTMLCanvasElement | null>,
  scene: Scene,
  { width, height, ink, paper, fps = 12 }: { width: number; height: number; ink: string; paper: string; fps?: number },
) {
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const out = canvas.getContext('2d');
    const src = document.createElement('canvas');
    src.width = width;
    src.height = height;
    const ctx = src.getContext('2d', { willReadFrequently: true });
    if (!out || !ctx) return;

    canvas.width = width;
    canvas.height = height;
    const frame = out.createImageData(width, height);
    const [ir, ig, ib] = hexToRgb(ink);
    const [pr, pg, pb] = hexToRgb(paper);

    const render = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      scene(ctx, width, height, t);
      const { data } = ctx.getImageData(0, 0, width, height);
      const px = frame.data;
      for (let y = 0; y < height; y++) {
        const row = BAYER_8[y & 7]!;
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const lum = (data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114) / 255;
          const on = lum > row[x & 7]!;
          px[i] = on ? pr : ir;
          px[i + 1] = on ? pg : ig;
          px[i + 2] = on ? pb : ib;
          px[i + 3] = 255;
        }
      }
      out.putImageData(frame, 0, 0);
    };

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    render(1.2);
    if (still) return;

    let raf = 0;
    let last = 0;
    let visible = true;
    const start = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || now - last < 1000 / fps) return;
      last = now;
      render((now - start) / 1000);
    };
    raf = requestAnimationFrame(loop);

    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    io.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [ref, scene, width, height, ink, paper, fps]);
}

/* ------------------------------------------------------------------ scenes */

/**
 * A pager on a lit surface, its screen showing the page it received. It vibrates
 * only when `buzz` is set: in the console that means something is really open, so
 * a quiet pager is never drawn ringing.
 */
const pagerScene = (headline: string, detail: string, buzz: boolean): Scene => (ctx, w, h, t) => {
  // Soft studio light from the upper left.
  const bg = ctx.createRadialGradient(w * 0.3, h * 0.2, 4, w * 0.5, h * 0.5, w * 0.85);
  bg.addColorStop(0, '#f2f2f2');
  bg.addColorStop(1, '#6a6a6a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // A buzz every few seconds: short, sharp, then still.
  const phase = t % 3.2;
  const buzzing = buzz && phase < 0.9;
  const jitter = buzzing ? Math.sin(t * 90) * 1.6 : 0;

  ctx.save();
  ctx.translate(w * 0.5 + jitter, h * 0.54);
  ctx.rotate(-0.2);

  // Vibration arcs radiate from the device while it buzzes.
  if (buzzing) {
    ctx.lineWidth = 2;
    for (let k = 0; k < 3; k++) {
      const r = 60 + k * 11 + (phase / 0.9) * 10;
      ctx.strokeStyle = `rgba(20,20,20,${0.55 - k * 0.15})`;
      ctx.beginPath();
      ctx.arc(0, 0, r, -0.55, 0.55);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, r, Math.PI - 0.55, Math.PI + 0.55);
      ctx.stroke();
    }
  }

  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(ctx, -52, -26, 112, 70, 14);
  ctx.fill();

  // Body.
  const body = ctx.createLinearGradient(0, -34, 0, 34);
  body.addColorStop(0, '#5a5a5a');
  body.addColorStop(1, '#0e0e0e');
  ctx.fillStyle = body;
  roundRect(ctx, -56, -34, 112, 68, 14);
  ctx.fill();

  // Belt clip, at the top edge.
  ctx.fillStyle = '#2a2a2a';
  roundRect(ctx, -18, -40, 36, 9, 3);
  ctx.fill();

  // Screen.
  const screen = ctx.createLinearGradient(-44, -24, 44, 8);
  screen.addColorStop(0, '#d8d8d8');
  screen.addColorStop(1, '#9d9d9d');
  ctx.fillStyle = screen;
  roundRect(ctx, -44, -24, 88, 30, 4);
  ctx.fill();

  ctx.fillStyle = '#0a0a0a';
  ctx.font = 'bold 15px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillText(headline, -38, -15);
  ctx.font = 'bold 9px ui-monospace, Menlo, monospace';
  ctx.fillText(detail, -38, -1);
  if (buzz && Math.floor(t * 2) % 2 === 0) ctx.fillRect(22, -21, 7, 12);

  // Buttons.
  ctx.fillStyle = '#bdbdbd';
  for (const x of [-32, -8, 16]) {
    roundRect(ctx, x, 14, 16, 8, 4);
    ctx.fill();
  }
  // Status LED.
  ctx.fillStyle = buzzing && Math.floor(t * 8) % 2 === 0 ? '#ffffff' : '#555555';
  ctx.beginPath();
  ctx.arc(44, 18, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

/**
 * The demo incident's error rate as two window averages either side of the merge.
 *
 * Only the two measured values are drawn — 64.3% and 0% — as flat levels. The
 * per-minute series is not in this page, so no line pretends to be one.
 */
const incidentScene: Scene = (ctx, w, h, t) => {
  // Pure white dithers to solid paper, so only the data carries texture.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  const floor = h - 10;
  const top = 12;
  const mergeX = w * 0.42;
  const level = floor - (floor - top) * 0.643;

  // The incident window: a gradient block, lit from the merge line.
  const g = ctx.createLinearGradient(0, level, 0, floor);
  g.addColorStop(0, '#262626');
  g.addColorStop(1, '#8a8a8a');
  ctx.fillStyle = g;
  ctx.fillRect(10, level, mergeX - 10, floor - level);

  // After the merge: zero errors, drawn as a hairline on the floor.
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(mergeX, floor - 2, w - mergeX - 10, 2);

  // The merge marker, and a scan line that sweeps across as a reading cursor.
  ctx.fillRect(mergeX - 1, 4, 2, floor - 4);
  const scan = 10 + ((t * 40) % (w - 20));
  const s = ctx.createLinearGradient(scan - 24, 0, scan, 0);
  s.addColorStop(0, 'rgba(0,0,0,0)');
  s.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = s;
  ctx.fillRect(scan - 24, 4, 24, floor - 4);

  // Baseline.
  ctx.fillStyle = '#555';
  ctx.fillRect(10, floor, w - 20, 1);
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* -------------------------------------------------------------- components */

export function DitherPager({
  headline = 'SEV1',
  detail = 'checkout-api',
  buzz = true,
  label = 'A pager receiving a SEV1 page for checkout-api',
  className = '',
}: {
  headline?: string;
  detail?: string;
  buzz?: boolean;
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const scene = useMemo(() => pagerScene(headline, detail, buzz), [headline, detail, buzz]);
  useDither(ref, scene, { width: 176, height: 176, ink: '#111111', paper: '#e9e6e0' });
  return (
    <canvas ref={ref} role="img" aria-label={label} className={`block h-full w-full [image-rendering:pixelated] ${className}`} />
  );
}

export function DitherIncident({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useDither(ref, incidentScene, { width: 360, height: 110, ink: '#131313', paper: '#e9e6e0', fps: 16 });
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label="Error rate: 64.3% between deploy and merge, 0% after the merge"
      className={`block h-full w-full [image-rendering:pixelated] ${className}`}
    />
  );
}
