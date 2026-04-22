"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

export function PasswordGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let active = true;

    const checkPasswordPolicy = async () => {
      await Promise.resolve();
      if (!active) return;
      if (!supabase) { setChecked(true); return; }
      if (pathname === "/driver/change-password") { setChecked(true); return; }

      const { data } = await supabase.auth.getUser();
      if (!active) return;
      const metadata = data.user?.user_metadata;
      const forceDriverChange = metadata?.force_password_change === true;
      const temporaryPassword = metadata?.password_change_required === true;
      if (forceDriverChange || temporaryPassword) {
        router.replace("/driver/change-password");
      } else {
        setChecked(true);
      }
    };

    void checkPasswordPolicy();
    return () => { active = false; };
  }, [pathname, router]);

  if (!checked) return null;
  return <>{children}</>;
}
