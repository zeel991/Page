import type { Metadata } from 'next';
import { SurfaceTransition } from '@/components/transition/surface-transition';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pager Developer',
  description: 'An AI production engineer that holds the pager — and stops exactly where a human should take over.',
};

/**
 * Stack Sans is loaded from Google Fonts by stylesheet rather than next/font: the
 * bundled next/font catalogue predates it. Every font stack falls back to system
 * faces, so a blocked font request degrades the typography, never the content.
 */
const FONTS =
  'https://fonts.googleapis.com/css2?family=Stack+Sans+Headline:wght@500..700&family=Stack+Sans+Text:wght@300..700&family=JetBrains+Mono:wght@400;500;600&display=swap';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body className="min-h-screen">
        <SurfaceTransition>{children}</SurfaceTransition>
      </body>
    </html>
  );
}
