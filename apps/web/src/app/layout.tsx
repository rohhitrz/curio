import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { JetBrains_Mono, Schibsted_Grotesk, Source_Serif_4 } from 'next/font/google';
import { SiteHeader } from '@/components/site-header';
import { cn } from '@/lib/utils';
import { Providers } from './providers';
import './globals.css';

/** Interface text and titles: a sturdy, editorial grotesk. */
const schibsted = Schibsted_Grotesk({ subsets: ['latin'], variable: '--font-sans' });
/** Long-form reading (lessons): a text serif is easier on the eyes over many paragraphs. */
const sourceSerif = Source_Serif_4({ subsets: ['latin'], variable: '--font-serif' });
/** Code examples in lessons and answers. */
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Curio',
  description: 'Learn from your sources with grounded, cited answers.',
};

/**
 * Applies the saved theme (or the system's) before the first paint, so a dark page never flashes
 * light. `ThemeToggle` writes the same key.
 */
const themeScript = `try{var t=localStorage.getItem('theme');var d=t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d)}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      // The theme script sets `dark` before React hydrates.
      suppressHydrationWarning
      className={cn(
        'font-sans antialiased',
        schibsted.variable,
        sourceSerif.variable,
        jetbrainsMono.variable,
      )}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
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
