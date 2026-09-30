'use client';

import { startTransition, useActionState, useEffect, useRef, type ReactNode } from 'react';
import type { FormState } from '@/app/(console)/actions';

/**
 * A form bound to a server action, showing the API's verdict beneath it. Field
 * problems are listed by field name, since the API names the field it refused.
 *
 * Submitted through `onSubmit` rather than the `action` attribute: React resets a
 * form after an action attribute runs, which would wipe everything typed whenever
 * the API refuses one field. Here the fields clear only on success.
 */
export function ActionForm({
  action,
  submit,
  children,
  className = '',
  tone = 'primary',
}: {
  action: (prev: FormState | null, form: FormData) => Promise<FormState>;
  submit: string;
  children?: ReactNode;
  className?: string;
  tone?: 'primary' | 'quiet';
}) {
  const [state, run, pending] = useActionState(action, null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);
  const button =
    tone === 'primary'
      ? 'bg-signal px-4 py-2 text-[12px] font-semibold text-paper hover:opacity-90'
      : 'border border-edge px-3 py-1.5 text-[11px] text-text hover:border-paper';
  return (
    <form
      ref={form}
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => run(data));
      }}
    >
      {children}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={`${button} disabled:opacity-50`}>
          {pending ? 'Working…' : submit}
        </button>
        {state && (
          <span role="status" className={`text-[11px] ${state.ok ? 'text-ok' : 'text-sev1'}`}>
            {state.message}
          </span>
        )}
      </div>
      {state?.problems && (
        <ul className="mt-2 space-y-0.5">
          {Object.entries(state.problems).map(([field, problem]) => (
            <li key={field} className="font-mono text-[11px] text-sev1">
              {field}: {problem}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
