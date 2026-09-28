import { auth } from '@clerk/nextjs/server';

/** Every page in `(app)` requires a signed-in user; others are sent to sign-in. */
export default async function AppLayout({ children }: LayoutProps<'/'>) {
  await auth.protect();
  return children;
}
