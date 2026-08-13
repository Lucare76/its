import AppShellLayout from "@/app/(app)/layout";

export default function ServicesLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AppShellLayout>{children}</AppShellLayout>;
}
