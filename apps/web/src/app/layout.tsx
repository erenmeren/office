import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { bricolageGrotesque, instrumentSans, jetbrainsMono } from './fonts';
import { AppShell } from '@/components/app-shell';
import { Providers } from '@/components/providers';

export const metadata: Metadata = { title: 'Office' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark h-full antialiased ${instrumentSans.variable} ${bricolageGrotesque.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-full">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
