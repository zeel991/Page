import Link from 'next/link';
import type { ReactNode } from 'react';
import { Magnet } from '@/components/motion/magnet';

/** The rounded pill that stands in for a logo mark in the reference design. */
export function PillMark({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`inline-block h-[14px] w-[34px] rounded-full border-[2.5px] border-current ${className}`} />;
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <PillMark />
      <span className="font-mono text-[12px] font-semibold tracking-tight lowercase">
        pager<span className="opacity-60">·</span>developer
      </span>
    </span>
  );
}

/**
 * The round call-to-action. Internal routes use Link; anything else is a plain
 * anchor that opens in a new tab.
 */
export function CircleLink({
  href,
  children,
  tone = 'paper',
  size = 'md',
}: {
  href: string;
  children: ReactNode;
  tone?: 'paper' | 'ink' | 'signal';
  size?: 'md' | 'lg';
}) {
  const tones = {
    paper: 'bg-paper text-carbon hover:bg-white',
    ink: 'bg-carbon text-paper hover:bg-black',
    signal: 'bg-signal text-white hover:bg-signal-deep',
  } as const;
  const sizes = { md: 'size-24 text-[12px]', lg: 'size-28 md:size-32 text-[13px]' } as const;
  const cls = `grid place-items-center rounded-full text-center font-medium leading-tight transition-colors ${tones[tone]} ${sizes[size]}`;
  const external = !href.startsWith('/') && !href.startsWith('#');
  return (
    <Magnet>
      {external ? (
        <a href={href} target="_blank" rel="noreferrer" className={cls}>
          {children}
        </a>
      ) : (
        <Link href={href} className={cls}>
          {children}
        </Link>
      )}
    </Magnet>
  );
}

/**
 * A vertical barcode drawn from a string, like the one on the reference hero.
 * Deterministic, so the server and client render identical bars.
 */
export function Barcode({ value, className = '' }: { value: string; className?: string }) {
  const bars: { h: number; y: number }[] = [];
  let y = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const h = (c % 3) + 1;
    bars.push({ h, y });
    y += h + ((c >> 2) % 2) + 2;
  }
  return (
    <svg viewBox={`0 0 24 ${y}`} className={className} aria-hidden preserveAspectRatio="none">
      {bars.map((b, i) => (
        <rect key={i} x="0" y={b.y} width="24" height={b.h} fill="currentColor" />
      ))}
    </svg>
  );
}

/** A band of text scrolling sideways forever; pauses under the cursor. */
export function Marquee({ items, className = '' }: { items: string[]; className?: string }) {
  const run = (hidden: boolean) => (
    <div className="flex shrink-0 items-center" aria-hidden={hidden || undefined}>
      {items.map((item) => (
        <span key={item} className="flex items-center">
          <span className="px-6">{item}</span>
          <span className="text-signal">✕</span>
        </span>
      ))}
    </div>
  );
  return (
    <div className={`group overflow-hidden ${className}`}>
      <div className="flex w-max animate-marquee group-hover:[animation-play-state:paused]">
        {run(false)}
        {run(true)}
      </div>
    </div>
  );
}

export function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`eyebrow opacity-60 ${className}`}>{children}</div>;
}
