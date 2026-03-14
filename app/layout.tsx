import type { Metadata } from "next";
import Script from "next/script";
import "@/lib/env-presence-log";
import "leaflet/dist/leaflet.css";
import "./globals.css";

const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "http://localhost:3010";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: {
    default: "Gestionale Ischia Transfer Beta",
    template: "%s | Gestionale Ischia Transfer Beta"
  },
  description: "Gestionale operativo Ischia Transfer Beta per dashboard, dispatch, area agenzia, pricing e PDF imports.",
  robots: {
    index: false,
    follow: false
  },
  openGraph: {
    title: "Gestionale Ischia Transfer Beta",
    description: "Gestionale operativo Ischia Transfer Beta.",
    url: appUrl,
    siteName: "Gestionale Ischia Transfer Beta",
    type: "website",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Ischia Transfer Beta"
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: "Gestionale Ischia Transfer Beta",
    description: "Gestionale operativo Ischia Transfer Beta.",
    images: ["/opengraph-image"]
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="it" className="light" suppressHydrationWarning>
      <body>
        <Script id="theme-init" strategy="beforeInteractive">
          {`
            try {
              const saved = localStorage.getItem('it-theme');
              const root = document.documentElement;
              if (saved === 'dark') {
                root.classList.add('dark');
                root.classList.remove('light');
              } else {
                root.classList.remove('dark');
                root.classList.add('light');
              }
            } catch {}
          `}
        </Script>
        {children}
      </body>
    </html>
  );
}
