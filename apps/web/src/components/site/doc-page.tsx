import Link from 'next/link';
import type { ReactNode } from 'react';
import { operator } from '@/lib/operator';
import { Wordmark } from './primitives';

export const SITE_LINKS = [
  ['Pricing', '/pricing'],
  ['Terms', '/terms'],
  ['Privacy', '/privacy'],
  ['Refunds', '/refunds'],
  ['Contact', '/contact'],
] as const;

/** The footer every public page carries: pricing, policies and a way to reach a person. */
export function SiteFooter({ tone = 'paper' }: { tone?: 'paper' | 'dark' }) {
  const { email } = operator();
  const muted = tone === 'dark' ? 'text-paper/60 hover:text-paper' : 'text-carbon/60 hover:text-carbon';
  return (
    <nav aria-label="Policies" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]">
      {SITE_LINKS.map(([label, href]) => (
        <Link key={href} href={href} className={muted}>
          {label}
        </Link>
      ))}
      {email && (
        <a href={`mailto:${email}`} className={muted}>
          {email}
        </a>
      )}
    </nav>
  );
}

/** A plain reading page: pricing, terms, privacy, refunds, contact. */
export function DocPage({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) {
  const { effective } = operator();
  return (
    <div className="min-h-screen bg-paper text-carbon">
      <div className="mx-auto max-w-[880px] px-5 md:px-10">
        <header className="flex items-center justify-between py-6">
          <Link href="/" aria-label="Home">
            <Wordmark />
          </Link>
          <Link href="/signin" className="eyebrow rounded-full border border-carbon/40 px-4 py-2 hover:bg-carbon hover:text-paper">
            Sign up
          </Link>
        </header>
        <main className="py-10">
          <div className="eyebrow text-carbon/60">{eyebrow}</div>
          <h1 className="display mt-3 text-[clamp(40px,7vw,72px)] leading-none">{title}</h1>
          {effective && <p className="mt-3 text-[12px] text-carbon/60">Effective {effective}</p>}
          <div className="doc mt-10 space-y-5 text-[15px] leading-relaxed [&_h2]:mt-10 [&_h2]:text-[20px] [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_a]:underline [&_a]:underline-offset-4">
            {children}
          </div>
        </main>
        <footer className="border-t border-carbon/15 py-6">
          <SiteFooter />
        </footer>
      </div>
    </div>
  );
}
