import Link from 'next/link';
import type { ReactNode } from 'react';
import { CountUp } from '@/components/motion/count-up';
import { Barcode } from '@/components/site/primitives';

/** Severity colours are load-bearing, so they are defined once. */
const SEVERITY_COLOR: Record<string, string> = {
  // SEV1 is filled as well as red, so it never depends on hue alone.
  SEV1: 'text-white border-sev1 bg-sev1',
  SEV2: 'text-sev2 border-sev2/40 bg-sev2/10',
  SEV3: 'text-sev3 border-sev3/40 bg-sev3/10',
  SEV4: 'text-sev4 border-sev4/40 bg-sev4/10',
};

/** Terminal states read differently from in-flight ones. */
const STATE_COLOR: Record<string, string> = {
  RESOLVED: 'text-ok border-ok/40 bg-ok/10',
  FALSE_POSITIVE: 'text-dim border-edge bg-panel-2',
  EXTERNAL_INCIDENT: 'text-sev4 border-sev4/40 bg-sev4/10',
  APPROVAL_REJECTED: 'text-dim border-edge bg-panel-2',
  UNRESOLVED: 'text-sev2 border-sev2/40 bg-sev2/10',
  AWAITING_APPROVAL: 'text-sev3 border-sev3/40 bg-sev3/10',
};

export function Severity({ value }: { value: string }) {
  return (
    <span className={`inline-block rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide ${SEVERITY_COLOR[value] ?? 'text-muted border-edge'}`}>
      {value}
    </span>
  );
}

export function State({ value }: { value: string }) {
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wide ${STATE_COLOR[value] ?? 'text-text border-edge bg-panel-2'}`}>
      {value}
    </span>
  );
}

/**
 * Attribution is rendered explicitly, including when it is unknown.
 *
 * An empty cell would read as "nothing to say"; "NOT DETERMINED" says that the
 * question was asked and has not been answered, which is the honest state for most
 * of an incident's life.
 */
export function Attribution({ value, confidence }: { value: string | null; confidence?: number | null }) {
  if (!value) {
    return <span className="font-mono text-[11px] text-dim">NOT DETERMINED</span>;
  }
  const tone =
    value === 'DEPLOYMENT_LIKELY_RESPONSIBLE'
      ? 'text-sev2'
      : value === 'EXTERNAL_INCIDENT' || value === 'DEPLOYMENT_NOT_RESPONSIBLE'
        ? 'text-ok'
        : 'text-muted';
  return (
    <span className={`font-mono text-[11px] ${tone}`}>
      {value.replaceAll('_', ' ')}
      {confidence != null && <span className="text-dim"> · {(confidence * 100).toFixed(0)}%</span>}
    </span>
  );
}

/**
 * A console section, set like the landing page's: a hairline rule across the
 * full width, a display-type heading, and the content beneath — no card chrome.
 */
export function Panel({
  title,
  subtitle,
  children,
  actions,
  dense,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  actions?: ReactNode;
  dense?: boolean;
}) {
  return (
    <section className="border-t border-graphite">
      <header className="flex items-end justify-between gap-4 px-4 pt-5 pb-4">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="display text-[clamp(22px,2.2vw,30px)] text-text">{title}</h2>
          {subtitle && <span className="eyebrow text-[10px] text-dim">{subtitle}</span>}
        </div>
        {actions}
      </header>
      <div className={dense ? '' : 'px-4 pb-4'}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'alert' | 'warn' | 'ok' }) {
  const color = tone === 'alert' ? 'text-sev1' : tone === 'warn' ? 'text-sev3' : tone === 'ok' ? 'text-ok' : 'text-text';
  return (
    <div className="bg-carbon px-4 pt-5 pb-6">
      <div className="eyebrow text-[10px] text-muted">{label}</div>
      <div className={`display mt-6 text-[clamp(48px,5vw,84px)] ${color}`}>
        {typeof value === 'number' ? <CountUp value={value} duration={900} /> : value}
      </div>
    </div>
  );
}

/** Stats set edge to edge on hairlines, like the landing page's Numbers band. */
export function StatGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`grid gap-px border-y border-graphite bg-graphite ${className}`}>{children}</div>;
}

/**
 * Every console page opens on a red band, the way the landing page opens on its
 * hero: the page's name set huge, context on the rule beneath it.
 */
export function PageHeader({
  eyebrow,
  title,
  meta,
  aside,
}: {
  eyebrow?: ReactNode;
  title: string;
  meta?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="relative -mx-4 -mt-6 overflow-hidden bg-signal px-4 pt-8 text-paper md:-mx-8 md:-mt-8 md:px-8 md:pt-12">
      <div className="flex flex-wrap items-end justify-between gap-6 pb-6">
        <div className="min-w-0">
          {eyebrow && <div className="eyebrow mb-4 text-[11px] opacity-80">{eyebrow}</div>}
          <h1 className="display animate-rise text-[clamp(56px,10vw,160px)]">{title}</h1>
        </div>
        {aside ?? <Barcode value={title} className="hidden h-24 w-6 text-paper md:block" />}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-paper/30 py-4">
        <span className="eyebrow text-[11px]">{meta}</span>
        <span className="eyebrow text-[11px] opacity-80">Read-only · never merges · never deploys</span>
      </div>
    </header>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-12 text-[13px] text-muted">{children}</div>;
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[11px] ${className}`}>{children}</span>;
}

export function IncidentLink({ id, label }: { id: string; label: string }) {
  return (
    <Link href={`/incidents/${id}`} className="font-mono text-[12px] font-semibold whitespace-nowrap text-accent underline-offset-4 hover:underline">
      {label}
    </Link>
  );
}

export function timeOf(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

export function dateOf(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}
