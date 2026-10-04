import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Source_Serif_4 } from 'next/font/google';
import { SiteHeader } from '@/components/site-header';
import { cn } from '@/lib/utils';
import { Providers } from './providers';
import './globals.css';

/** Interface text. */
const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
/** Long-form reading (lessons): a text serif is easier on the eyes over many paragraphs. */
const sourceSerif = Source_Serif_4({ subsets: ['latin'], variable: '--font-serif' });
/** Code examples in lessons and answers. */
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Curio',
  description: 'Learn from your sources with grounded, cited answers.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={cn(
        'font-sans antialiased',
        inter.variable,
        sourceSerif.variable,
        jetbrainsMono.variable,
      )}
    >
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
