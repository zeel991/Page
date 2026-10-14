'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const CONSOLE_NAV = [
  ['Setup', '/onboarding', '00'],
  ['Overview', '/dashboard', '01'],
  ['Incidents', '/incidents', '02'],
  ['Deployments', '/deployments', '03'],
  ['Agent Runs', '/agent-runs', '04'],
  ['Services', '/services', '05'],
  ['Settings', '/settings', '06'],
  ['Policies', '/policies', '07'],
] as const;

const ROW = 40;

type Item = (typeof CONSOLE_NAV)[number];

/** Setup leaves the navigation once a service is being watched; it stays reachable from Services. */
function items(hideSetup: boolean): readonly Item[] {
  return hideSetup ? CONSOLE_NAV.filter(([, href]) => href !== '/onboarding') : CONSOLE_NAV;
}

function activeIndex(nav: readonly Item[], pathname: string): number {
  return nav.findIndex(([, href]) => pathname === href || pathname.startsWith(`${href}/`));
}

/** Sidebar navigation. The red marker glides to the active row rather than jumping. */
export function SideNav({ hideSetup = false }: { hideSetup?: boolean }) {
  const nav = items(hideSetup);
  const active = activeIndex(nav, usePathname());
  return (
    <ul className="relative px-3">
      {active >= 0 && (
        <span
          aria-hidden
          className="absolute right-3 left-3 bg-graphite/60 transition-transform duration-300 ease-out"
          style={{ height: ROW, transform: `translateY(${active * ROW}px)` }}
        >
          <span className="absolute top-0 bottom-0 left-0 w-[3px] bg-signal" />
        </span>
      )}
      {nav.map(([label, href, n], i) => (
        <li key={href} className="relative">
          <Link
            href={href}
            aria-current={i === active ? 'page' : undefined}
            className={`eyebrow flex items-center gap-3 px-4 text-[12px] transition-colors ${i === active ? 'text-paper' : 'text-muted hover:text-paper'}`}
            style={{ height: ROW }}
          >
            <span className="font-mono text-[10px] text-dim">{n}</span>
            {label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The same navigation as a horizontal strip, for narrow screens. */
export function TopNav({ hideSetup = false }: { hideSetup?: boolean }) {
  const nav = items(hideSetup);
  const active = activeIndex(nav, usePathname());
  return (
    <ul className="flex gap-1 overflow-x-auto px-4 pb-3 [scrollbar-width:none]">
      {nav.map(([label, href], i) => (
        <li key={href}>
          <Link
            href={href}
            className={`block rounded-full border px-3 py-1.5 text-[12px] whitespace-nowrap ${i === active ? 'border-signal bg-signal text-white' : 'border-edge text-muted'}`}
          >
            {label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
