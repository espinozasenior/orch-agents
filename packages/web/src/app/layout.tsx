import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'orch-agents',
  description: 'Live operational view for orch-agents',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <aside className="w-56 shrink-0 border-r border-border bg-surface px-4 py-6">
            <h1 className="mb-8 text-lg font-semibold tracking-tight">
              orch<span className="text-accent">-</span>agents
            </h1>
            <nav className="flex flex-col gap-1 text-sm">
              <NavLink href="/">Runs</NavLink>
              <NavLink href="/automations">Automations</NavLink>
              <NavLink href="/settings/secrets">Secrets</NavLink>
              <NavLink href="/settings/tokens">Tokens</NavLink>
            </nav>
          </aside>
          <main className="flex-1 overflow-x-hidden">{children}</main>
        </div>
      </body>
    </html>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-2 text-text/80 transition-colors hover:bg-border/30 hover:text-text"
    >
      {children}
    </Link>
  );
}
