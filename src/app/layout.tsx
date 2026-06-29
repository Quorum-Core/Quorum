import type { Metadata, Viewport } from 'next';
import { Inter, Geist } from 'next/font/google';
import Script from 'next/script';
import './globals.css';
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

const GA_ID = process.env.NEXT_PUBLIC_GA_ID || '';

const inter = Inter({ subsets: ['latin'] });

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#030712',
};

export const metadata: Metadata = {
  title: 'Quorum — Your AI-Powered Company',
  description: 'Quorum — orchestrate a team of AI agents. Chat with each agent, run meetings, and watch them work.',
  keywords: ['AI', 'AI workforce', 'interactive', 'Quorum', 'agents'],
  openGraph: {
    title: 'Quorum — Your AI-Powered Company',
    description: '30 AI agents orchestrated. Run meetings, assign tasks, and build your AI-powered company.',
    type: 'website',
    siteName: 'Quorum',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary',
    title: 'Quorum — Your AI-Powered Company',
    description: '30 AI agents. Build your AI-powered company for $0/month.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)}>
      {GA_ID && (
        <>
          <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
          <Script id="ga4" strategy="afterInteractive">
            {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');`}
          </Script>
        </>
      )}
      <body className={`${inter.className} antialiased`}>{children}</body>
    </html>
  );
}
