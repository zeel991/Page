import Link from 'next/link';
import { signIn } from '@/auth';
import { Wordmark } from '@/components/site/primitives';
import { sameSitePath } from '@/lib/same-site-path';

export const dynamic = 'force-dynamic';

/**
 * Sign up and sign in are the same step: the first sign-in with GitHub creates a
 * workspace with you as its owner.
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const { callbackUrl } = await searchParams;
  const target = sameSitePath(callbackUrl) ?? '/onboarding';
  return (
    <main className="flex min-h-screen items-center justify-center bg-carbon px-4">
      <div className="w-full max-w-md border border-graphite bg-ink p-8">
        <Link href="/" className="text-text">
          <Wordmark />
        </Link>
        <h1 className="display mt-8 text-[40px] leading-none text-paper">Sign up with GitHub</h1>
        <p className="mt-4 text-[13px] leading-relaxed text-muted">
          Your first sign-in creates a workspace with you as its owner. From there you install the GitHub App on
          the repositories you choose, connect Datadog and Slack, and add a service to watch.
        </p>
        <form
          className="mt-8"
          action={async () => {
            'use server';
            await signIn('github', { redirectTo: target });
          }}
        >
          <button type="submit" className="w-full bg-signal px-4 py-3 text-[14px] font-semibold text-paper hover:opacity-90">
            Continue with GitHub
          </button>
        </form>
        <p className="mt-6 text-[11px] leading-snug text-dim">
          Pager Developer never merges and never deploys. Signing in grants it nothing on your repositories; that
          happens only when you install the app, on the repositories you pick.
        </p>
      </div>
    </main>
  );
}
