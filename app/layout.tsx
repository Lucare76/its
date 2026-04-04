import type { Metadata } from "next";
import Script from "next/script";
import "@/lib/env-presence-log";
import { getConfiguredAppUrl } from "@/lib/app-url";
import "leaflet/dist/leaflet.css";
import "./globals.css";

const appUrl = getConfiguredAppUrl() ?? "http://127.0.0.1:3010";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: {
    default: "Transfer Ischia affidabile | Ischia Transfer Service dal 2006",
    template: "%s | Ischia Transfer Service dal 2006"
  },
  description:
    "Transfer Ischia affidabile con servizio attivo dal 2006, coordinamento diretto tra aeroporto, porto e hotel e risposta rapida per gli arrivi sull'isola.",
  robots: {
    index: false,
    follow: false
  },
  openGraph: {
    title: "Transfer Ischia affidabile | Ischia Transfer Service dal 2006",
    description:
      "Servizio transfer attivo dal 2006 con coordinamento diretto tra aeroporto, porto e hotel.",
    url: appUrl,
    siteName: "Ischia Transfer Service",
    type: "website",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Ischia Transfer Service dal 2006"
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: "Transfer Ischia affidabile | Ischia Transfer Service dal 2006",
    description:
      "Servizio transfer attivo dal 2006 con coordinamento diretto tra aeroporto, porto e hotel.",
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
