import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="font-semibold tracking-tight">
          Curio
        </Link>
        <nav className="flex items-center gap-2">
          <Show when="signed-out">
            <SignInButton>
              <Button variant="ghost">Sign in</Button>
            </SignInButton>
            <SignUpButton>
              <Button>Sign up</Button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <Button variant="ghost" nativeButton={false} render={<Link href="/notebooks" />}>
              Notebooks
            </Button>
            <Button variant="ghost" nativeButton={false} render={<Link href="/memories" />}>
              Memory
            </Button>
            <UserButton />
          </Show>
        </nav>
      </div>
    </header>
  );
}
