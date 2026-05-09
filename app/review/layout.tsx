import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Revisione riepilogo — Ischia Transfer Service",
};

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return <div style={{ margin: 0, padding: 0 }}>{children}</div>;
}
