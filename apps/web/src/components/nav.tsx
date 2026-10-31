'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { post } from '@/lib/api';

const LINKS = [
  ['/', 'Dashboard'],
  ['/tasks/new', 'New task'],
  ['/agents', 'Agents'],
  ['/skills', 'Skills'],
  ['/workers', 'Workers'],
] as const;

export function Nav() {
  if (usePathname() === '/login') return null;
  const logout = async () => {
    await post('/auth/logout');
    window.location.assign('/login');
  };
  return (
    <nav className="flex items-center gap-4 border-b px-6 py-3 text-sm">
      <span className="font-semibold">Office</span>
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href} className="text-muted-foreground hover:text-foreground">
          {label}
        </Link>
      ))}
      <Button variant="ghost" size="sm" className="ml-auto" onClick={logout}>
        Log out
      </Button>
    </nav>
  );
}
