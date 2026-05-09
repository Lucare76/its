import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Scheda Veicolo — Ischia Transfer Service",
};

export default function VehicleLayout({ children }: { children: React.ReactNode }) {
  return <div style={{ margin: 0, padding: 0, background: "#0f172a" }}>{children}</div>;
}
