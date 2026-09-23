'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A curtain between the two surfaces: the landing page and the console.
 *
 * Crossing from one to the other wipes a signal-red panel up over the page, names
 * the destination while the route loads, then lifts it off the new page. Moves
 * within a surface stay instant — the curtain marks a change of place, not every
 * click. Browser back/forward and reduced-motion readers skip it entirely.
 */

type Surface = 'site' | 'console';
type Phase = 'idle' | 'cover' | 'hold' | 'reveal';

const surfaceOf = (path: string): Surface => (path === '/' ? 'site' : 'console');

const COVER_MS = 560;
const REVEAL_MS = 700;
// If a route takes this long to commit, lift the curtain anyway rather than trap the reader.
const GIVE_UP_MS = 6000;

const Ctx = createContext<(href: string) => void>(() => {});

/** Navigate, with the curtain when the destination is on the other surface. */
export const useSurfaceNavigate = () => useContext(Ctx);

export function SurfaceTransition({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>('idle');
  const [to, setTo] = useState<Surface>('console');
  const target = useRef<string | null>(null);

  const navigate = useCallback(
    (href: string) => {
      const url = new URL(href, window.location.href);
      const crosses = surfaceOf(url.pathname) !== surfaceOf(window.location.pathname);
      if (!crosses || phase !== 'idle' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        router.push(href);
        return;
      }
      router.prefetch(href);
      target.current = url.pathname;
      setTo(surfaceOf(url.pathname));
      setPhase('cover');
      setTimeout(() => {
        setPhase('hold');
        router.push(href);
      }, COVER_MS);
    },
    [phase, router],
  );

  // Catch plain clicks on internal links that cross surfaces. Registered in the
  // capture phase so it runs before Next's Link handler, which then sees the
  // event as handled and stands down.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest('a');
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.hash) return;
      if (surfaceOf(url.pathname) === surfaceOf(window.location.pathname)) return;
      e.preventDefault();
      navigate(url.pathname + url.search);
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, [navigate]);

  // Lift the curtain once the destination has committed.
  useEffect(() => {
    if (phase === 'hold' && pathname === target.current) {
      window.scrollTo(0, 0);
      setPhase('reveal');
    }
  }, [phase, pathname]);

  useEffect(() => {
    if (phase === 'hold') {
      const t = setTimeout(() => setPhase('reveal'), GIVE_UP_MS);
      return () => clearTimeout(t);
    }
    if (phase === 'reveal') {
      const t = setTimeout(() => setPhase('idle'), REVEAL_MS);
      return () => clearTimeout(t);
    }
  }, [phase]);

  // Longhand transition properties only: React warns, rightly, when a shorthand and
  // its longhands are mixed across rerenders, because the result is order-dependent.
  const ease = 'cubic-bezier(0.76, 0, 0.24, 1)';
  const moving = (ms: number): React.CSSProperties => ({
    transitionProperty: 'transform',
    transitionDuration: `${ms}ms`,
    transitionTimingFunction: ease,
  });
  const panel: Record<Phase, React.CSSProperties> = {
    idle: { transform: 'translateY(100%)', visibility: 'hidden', transitionDuration: '0ms' },
    cover: { transform: 'translateY(0)', ...moving(COVER_MS) },
    hold: { transform: 'translateY(0)', transitionDuration: '0ms' },
    reveal: { transform: 'translateY(-100%)', ...moving(REVEAL_MS) },
  };
  const covering = phase === 'cover' || phase === 'hold';

  return (
    <Ctx.Provider value={navigate}>
      {children}
      <div aria-hidden={phase === 'idle'} className="pointer-events-none fixed inset-0 z-[100]">
        {/* A dark leading edge runs just ahead of the red, so the wipe reads as a layer, not a flash. */}
        <div
          className="absolute inset-0 bg-carbon"
          style={{
            ...panel[phase],
            transitionDelay: phase === 'reveal' ? '90ms' : '0ms',
          }}
        />
        <div
          className="absolute inset-0 flex flex-col justify-between bg-signal p-5 text-paper md:p-10"
          style={{ ...panel[phase], transitionDelay: phase === 'cover' ? '70ms' : '0ms' }}
          role={covering ? 'status' : undefined}
        >
          <span className="eyebrow flex items-center gap-2.5">
            <span className="inline-block h-[14px] w-[34px] rounded-full border-[2.5px] border-current" />
            {to === 'console' ? 'Opening the command centre' : 'Back to the site'}
          </span>
          <div
            className="display text-[clamp(64px,14vw,220px)] transition-[opacity,transform] duration-500"
            style={{
              opacity: covering ? 1 : 0,
              transform: covering ? 'none' : 'translateY(-40px)',
              transitionDelay: phase === 'cover' ? '260ms' : '0ms',
            }}
          >
            {to === 'console' ? 'Dashboard' : 'Pager'}
          </div>
          <div className="h-[3px] w-full overflow-hidden bg-paper/25">
            <div
              className="h-full bg-paper"
              style={{
                width: phase === 'idle' ? '0%' : phase === 'cover' ? '45%' : phase === 'hold' ? '85%' : '100%',
                transitionProperty: 'width',
                transitionDuration: phase === 'hold' ? '3s' : '500ms',
                transitionTimingFunction: phase === 'hold' ? 'cubic-bezier(0.1, 0.7, 0.2, 1)' : 'ease-out',
              }}
            />
          </div>
        </div>
      </div>
    </Ctx.Provider>
  );
}
