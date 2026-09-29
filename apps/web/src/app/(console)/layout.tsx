import Link from 'next/link';
import { signOut } from '@/auth';
import { api } from '@/lib/api';
import { CommandPalette } from '@/components/console/command-palette';
import { SideNav, TopNav } from '@/components/console/nav';
import { Wordmark } from '@/components/site/primitives';

const LEVEL_MEANING: Record<string, string> = {
  L0: 'Observes telemetry only.',
  L1: 'May investigate. May not write anywhere.',
  L2: 'May prepare a fix in a sandbox and report. May not open a pull request.',
  L3: 'May open a pull request. May not execute remediation.',
  L4: 'May merge on a recorded human approval.',
  L5: 'May act on pre-authorised remediation.',
};

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  // The workspace's own level, read from the database — not a constant in the page.
  const me = await api<{ user: { login: string | null; name: string } | null; role: string; workspaces: { id: string; name: string }[]; organizationId: string }>('/api/me');
  const policy = await api<{ autonomyLevel: string | null }>('/api/policies');
  const level = policy.autonomyLevel ?? '—';
  const workspace = me.workspaces.find((w) => w.id === me.organizationId);
  return (
    <div className="flex min-h-screen bg-carbon">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-graphite bg-ink md:flex">
        <div className="px-6 pt-6 pb-8">
          <Link href="/" className="text-text">
            <Wordmark />
          </Link>
          <div className="eyebrow mt-2 text-[10px] text-dim">Incident command centre</div>
        </div>

        <SideNav />

        <div className="mx-6 mt-8 border-t border-graphite pt-5">
          <div className="eyebrow text-[10px] text-dim">Autonomy</div>
          <div className="display mt-3 text-[64px] text-paper">{level}</div>
          <p className="mt-2 text-[11px] leading-snug text-muted">{LEVEL_MEANING[level] ?? 'Unknown level.'}</p>
        </div>

        <div className="mt-auto space-y-3 px-6 pb-6">
          <div className="bg-signal p-4 text-paper">
            <div className="display text-[22px]">A human decides</div>
            <div className="mt-2 text-[11px] leading-snug opacity-90">
              Never merges. Never deploys. That decision stays with a person.
            </div>
          </div>
          <Link href="/" className="eyebrow block text-[11px] text-dim hover:text-paper">
            ← Back to site
          </Link>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 border-b border-graphite bg-carbon/90 backdrop-blur-md">
          <div className="flex items-center justify-between px-4 py-3 md:px-8">
            <Link href="/" className="text-text md:hidden">
              <Wordmark />
            </Link>
            <span className="eyebrow hidden items-center gap-2 text-[10px] text-dim md:flex">
              <span className="size-1.5 rounded-full bg-ok" />
              {workspace?.name ?? 'Workspace'} · {me.user?.login ?? me.user?.name} · {me.role}
            </span>
            <div className="flex items-center gap-4">
              <CommandPalette />
              <form
                action={async () => {
                  'use server';
                  await signOut({ redirectTo: '/' });
                }}
              >
                <button type="submit" className="eyebrow text-[10px] text-dim hover:text-paper">Sign out</button>
              </form>
            </div>
          </div>
          <div className="md:hidden">
            <TopNav />
          </div>
        </header>
        <main className="px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
