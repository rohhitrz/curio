import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import { Brain, GraduationCap, NotebookPen } from 'lucide-react';
import Link from 'next/link';
import { ApiStatus } from '@/app/api-status';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';

export function SiteHeader() {
  return (
    <header className="bg-background/85 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-2">
          <Link href="/" className="text-heading text-lg font-bold tracking-tight">
            Curio
          </Link>
          <ApiStatus />
        </div>
        <nav className="flex items-center gap-1 sm:gap-2">
          <ThemeToggle />
          <Show when="signed-out">
            <SignInButton>
              <Button variant="ghost">Sign in</Button>
            </SignInButton>
            <SignUpButton>
              <Button>Sign up</Button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <Button
              variant="ghost"
              nativeButton={false}
              render={<Link href="/notebooks" aria-label="Notebooks" />}
              className="max-sm:px-2"
            >
              <NotebookPen className="sm:hidden" aria-hidden />
              <span className="max-sm:hidden">Notebooks</span>
            </Button>
            <Button
              variant="ghost"
              nativeButton={false}
              render={<Link href="/learn" aria-label="Learn" />}
              className="max-sm:px-2"
            >
              <GraduationCap className="sm:hidden" aria-hidden />
              <span className="max-sm:hidden">Learn</span>
            </Button>
            <Button
              variant="ghost"
              nativeButton={false}
              render={<Link href="/memories" aria-label="Memory" />}
              className="max-sm:px-2"
            >
              <Brain className="sm:hidden" aria-hidden />
              <span className="max-sm:hidden">Memory</span>
            </Button>
            <UserButton />
          </Show>
        </nav>
      </div>
    </header>
  );
}
