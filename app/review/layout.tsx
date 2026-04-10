import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Revisione riepilogo — Ischia Transfer Service",
};

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </head>
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
