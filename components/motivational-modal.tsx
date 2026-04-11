"use client";

import { useEffect, useState } from "react";
import { getMotivationalQuote } from "@/lib/motivational-quotes";

type Props = {
  storageIdentity?: string | null;
  userName?: string | null;
};

type StoredState = {
  date: string;
  quote: string;
};

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function storageKey(identity?: string | null) {
  const suffix = identity?.trim() ? identity.trim().toLowerCase() : "anonymous";
  return `motivational-modal:${suffix}`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Buongiorno";
  if (h < 18) return "Buon pomeriggio";
  return "Buonasera";
}

function firstNameOnly(fullName?: string | null) {
  if (!fullName?.trim()) return null;
  return fullName.trim().split(" ")[0];
}

export function MotivationalModal({ storageIdentity, userName }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [quote, setQuote] = useState<string | null>(null);

  useEffect(() => {
    const isDev = typeof window !== "undefined" && window.location.hostname === "localhost";
    const key = storageKey(storageIdentity);
    const today = todayKey();

    if (!isDev) {
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const stored = JSON.parse(raw) as StoredState;
          if (stored?.date === today) return;
        }
      } catch {
        localStorage.removeItem(key);
      }
    }

    getMotivationalQuote()
      .then((q) => {
        setQuote(q);
        // Piccolo ritardo per non apparire subito al caricamento
        setTimeout(() => setIsOpen(true), 1200);
        if (!isDev) localStorage.setItem(key, JSON.stringify({ date: today, quote: q }));
      })
      .catch(() => undefined);
  }, [storageIdentity]);

  if (!isOpen || !quote) return null;

  const firstName = firstNameOnly(userName);

  return (
    <div
      className="fixed bottom-5 right-5 z-50 w-72 rounded-2xl shadow-xl border border-slate-200 bg-white overflow-hidden"
      style={{ animation: "slideUpFade 0.3s ease-out" }}
    >
      <style>{`
        @keyframes slideUpFade {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Striscia colorata sottile in cima */}
      <div className="h-1 w-full" style={{ background: "linear-gradient(90deg, #4338ca, #7c3aed)" }} />

      <div className="px-4 pt-3 pb-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-slate-500">
            {greeting()}{firstName ? `, ${firstName}` : ""} ⛴
          </span>
          <button
            onClick={() => setIsOpen(false)}
            className="text-slate-300 hover:text-slate-500 transition text-lg leading-none"
            aria-label="Chiudi"
          >
            ×
          </button>
        </div>

        {/* Frase */}
        <p className="text-xs text-slate-600 leading-relaxed italic">
          &ldquo;{quote}&rdquo;
        </p>
      </div>
    </div>
  );
}
