import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import { SiteHeader } from '@/components/site-header';
import { cn } from '@/lib/utils';
import { Providers } from './providers';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Curio',
  description: 'Learn from your sources with grounded, cited answers.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={cn('font-sans', geist.variable)}>
      <body>
        <ClerkProvider
          appearance={{
            variables: {
              colorPrimary: 'var(--primary)',
              colorBackground: 'var(--background)',
              colorForeground: 'var(--foreground)',
              colorMutedForeground: 'var(--muted-foreground)',
              colorInput: 'var(--input)',
              colorBorder: 'var(--border)',
              borderRadius: 'var(--radius)',
              fontFamily: 'var(--font-sans)',
            },
          }}
        >
          <Providers>
            <SiteHeader />
            {children}
          </Providers>
        </ClerkProvider>
      </body>
    </html>
  );
}
