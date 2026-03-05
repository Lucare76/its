import type { Metadata } from "next";
import Link from "next/link";
import Script from "next/script";
import "@/lib/env-presence-log";
import "leaflet/dist/leaflet.css";
import "./globals.css";

const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "https://example.com";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: "Ischia Transfer Beta",
  description: "Demo professionale per agenzie transfer",
  openGraph: {
    title: "Ischia Transfer Beta",
    description: "Gestione transfer Ischia con dispatch, driver app e reminder WhatsApp.",
    url: appUrl,
    siteName: "Ischia Transfer",
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
    title: "Ischia Transfer Beta",
    description: "Gestione transfer Ischia con dispatch, driver app e reminder WhatsApp.",
    images: ["/opengraph-image"]
  }
};

const navItems = [
  { href: "/", label: "Landing" },
  { href: "/dashboard", label: "Operator" },
  { href: "/onboarding", label: "Onboarding" },
  { href: "/analytics", label: "Analytics" },
  { href: "/services/new", label: "Nuovo Servizio" },
  { href: "/agency", label: "Agency" },
  { href: "/agency/bookings", label: "Mie Prenotazioni" },
  { href: "/dispatch", label: "Dispatch" },
  { href: "/bus-tours", label: "Bus Tours" },
  { href: "/planning", label: "Planning" },
  { href: "/driver", label: "Driver" },
  { href: "/map", label: "Mappa" },
  { href: "/ingestion", label: "Ingestion" },
  { href: "/inbox", label: "Inbox" }
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const supabaseConfigured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

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
        <header className="border-b border-border/80 bg-white/80 backdrop-blur-sm">
          <nav className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-3">
            <Link href="/" className="text-base font-semibold tracking-tight text-text">
              Ischia Transfer Beta
            </Link>
            <div className="hidden gap-2 md:flex">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-lg px-2.5 py-1.5 text-sm text-muted transition hover:bg-surface-2 hover:text-text"
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </nav>
          {process.env.NODE_ENV === "development" ? (
            <div className="mx-auto w-full max-w-7xl px-4 pb-2 text-xs text-muted">
              Supabase configured: {String(supabaseConfigured)}
            </div>
          ) : null}
        </header>
        <main className="mx-auto w-full max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
