"use client";

/**
 * PwaInit — registrazione Service Worker, install prompt PWA e iscrizione push.
 * Montato nel layout della sezione /driver; non renderizza nulla di visibile da solo.
 * Il banner di installazione e il bottone push vengono esposti via contesto globale
 * accessibile dal DriverPage.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

/* ------------------------------------------------------------------ types */

type PwaContextValue = {
  swReady: boolean;
  pushState: "unsupported" | "blocked" | "subscribed" | "unsubscribed" | "loading";
  installPromptAvailable: boolean;
  triggerInstall: () => void;
  subscribePush: () => Promise<void>;
  unsubscribePush: () => Promise<void>;
};

/* ------------------------------------------------------------------ context */

const PwaContext = createContext<PwaContextValue>({
  swReady: false,
  pushState: "loading",
  installPromptAvailable: false,
  triggerInstall: () => undefined,
  subscribePush: async () => undefined,
  unsubscribePush: async () => undefined,
});

export function usePwa() {
  return useContext(PwaContext);
}

/* ------------------------------------------------------------------ helpers */

async function getToken(): Promise<string | null> {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

/* ================================================================ COMPONENT */

export function PwaInit({ children }: { children?: React.ReactNode }) {
  const [swReady, setSwReady] = useState(false);
  const [pushState, setPushState] = useState<PwaContextValue["pushState"]>("loading");
  const [installPromptAvailable, setInstallPromptAvailable] = useState(false);
  const swReg = useRef<ServiceWorkerRegistration | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deferredPrompt = useRef<any>(null);

  /* ------------- SW registration */
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      setPushState("unsupported");
      return;
    }

    navigator.serviceWorker
      .register("/sw.js", { scope: "/driver" })
      .then((reg) => {
        swReg.current = reg;
        setSwReady(true);

        // Controlla stato push attuale
        if (!("PushManager" in window)) {
          setPushState("unsupported");
          return;
        }
        if (Notification.permission === "denied") {
          setPushState("blocked");
          return;
        }
        reg.pushManager.getSubscription().then((sub) => {
          setPushState(sub ? "subscribed" : "unsubscribed");
        });
      })
      .catch(() => {
        setSwReady(false);
        setPushState("unsupported");
      });
  }, []);

  /* ------------- Install prompt (Chrome/Android) */
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPrompt.current = e;
      setInstallPromptAvailable(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  useEffect(() => {
    const handler = () => setInstallPromptAvailable(false);
    window.addEventListener("appinstalled", handler);
    return () => window.removeEventListener("appinstalled", handler);
  }, []);

  /* ------------- Trigger install */
  const triggerInstall = useCallback(() => {
    if (!deferredPrompt.current) return;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    void deferredPrompt.current.prompt();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    deferredPrompt.current.userChoice.then(() => {
      deferredPrompt.current = null;
      setInstallPromptAvailable(false);
    });
  }, []);

  /* ------------- Subscribe push */
  const subscribePush = useCallback(async () => {
    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!vapidKey || !swReg.current) return;

    setPushState("loading");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState("blocked");
        return;
      }
      const sub = await swReg.current.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      const token = await getToken();
      if (!token) { setPushState("unsubscribed"); return; }
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.toJSON().keys }),
      });
      setPushState("subscribed");
    } catch {
      setPushState("unsubscribed");
    }
  }, []);

  /* ------------- Unsubscribe push */
  const unsubscribePush = useCallback(async () => {
    if (!swReg.current) return;
    setPushState("loading");
    try {
      const sub = await swReg.current.pushManager.getSubscription();
      if (sub) {
        const token = await getToken();
        if (token) {
          await fetch("/api/push/subscribe", {
            method: "DELETE",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
        }
        await sub.unsubscribe();
      }
      setPushState("unsubscribed");
    } catch {
      setPushState("unsubscribed");
    }
  }, []);

  return (
    <PwaContext.Provider value={{ swReady, pushState, installPromptAvailable, triggerInstall, subscribePush, unsubscribePush }}>
      {children}
    </PwaContext.Provider>
  );
}
