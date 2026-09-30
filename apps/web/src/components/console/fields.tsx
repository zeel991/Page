import type { ReactNode } from 'react';

/** A labelled input, styled once for every console form. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="eyebrow text-[10px] text-dim">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[10px] text-muted">{hint}</span>}
    </label>
  );
}

export const INPUT = 'w-full border border-edge bg-carbon px-3 py-2 font-mono text-[12px] text-text outline-none focus:border-paper';
