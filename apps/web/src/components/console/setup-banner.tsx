'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * One line on every console page until setup is complete, and again whenever a
 * finished setup has something that stopped working. Not on setup itself.
 */
export function SetupBanner({ done, total, complete, attention }: { done: number; total: number; complete: boolean; attention: boolean }) {
  if (usePathname() === '/onboarding') return null;
  return (
    <Link
      href={complete ? '/onboarding?edit' : '/onboarding'}
      className={`flex items-center justify-between gap-4 border px-4 py-2 text-[12px] ${attention ? 'border-sev3/50 text-sev3' : 'border-accent/50 text-text'} hover:border-paper`}
    >
      <span>
        {attention ? 'Setup needs attention' : 'Setup'} · {done} of {total} steps done
      </span>
      <span className="eyebrow text-[10px]">{complete ? 'See what' : 'Continue'} →</span>
    </Link>
  );
}
