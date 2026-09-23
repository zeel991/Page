'use client';

import { useState } from 'react';

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      // Clipboard access can be refused; say so rather than pretending it worked.
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1600);
  };

  return (
    <button type="button" onClick={copy} className={className}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy blocked' : 'Copy'}
    </button>
  );
}
