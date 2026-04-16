import type { Metadata, Viewport } from "next";
import { PwaInit } from "@/components/driver/PwaInit";
import { PasswordGuard } from "@/components/driver/PasswordGuard";

export const metadata: Metadata = {
  title: "ITS Driver",
  description: "Ischia Transfer Service — app autisti",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ITS Driver",
  },
  icons: {
    apple: "/brand/logo-ischia-transfer-email.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function DriverLayout({ children }: { children: React.ReactNode }) {
  return (
    <PwaInit>
      <PasswordGuard>
        {children}
      </PasswordGuard>
    </PwaInit>
  );
}
