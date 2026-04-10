import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Scheda Veicolo — Ischia Transfer Service",
};

export default function VehicleLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </head>
      <body style={{ margin: 0, padding: 0, background: "#0f172a" }}>{children}</body>
    </html>
  );
}
