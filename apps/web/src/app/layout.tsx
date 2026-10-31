import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Nav } from '@/components/nav';
import { Providers } from '@/components/providers';

export const metadata: Metadata = { title: 'Office' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <body className="min-h-full">
        <Providers>
          <Nav />
          <main className="mx-auto max-w-5xl p-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
