"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

export function PasswordGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!supabase) { setChecked(true); return; }
    if (pathname === "/driver/change-password") { setChecked(true); return; }

    supabase.auth.getUser().then(({ data }) => {
      const flag = data.user?.user_metadata?.force_password_change;
      if (flag === true) {
        router.replace("/driver/change-password");
      } else {
        setChecked(true);
      }
    });
  }, [pathname, router]);

  if (!checked) return null;
  return <>{children}</>;
}
