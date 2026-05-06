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
    if (process.env.NEXT_PUBLIC_E2E_TEST_MODE === "true") return;

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
        setTimeout(() => setIsOpen(true), 1200);
        if (!isDev) localStorage.setItem(key, JSON.stringify({ date: today, quote: q }));
      })
      .catch(() => undefined);
  }, [storageIdentity]);

  if (!isOpen || !quote) return null;

  const firstName = firstNameOnly(userName);

  return (
    <>
      <style>{`
        @keyframes popIn {
          from { opacity: 0; transform: scale(0.95) translateY(8px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>

      {/* Backdrop leggero — click chiude */}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center px-4"
        style={{ background: "rgba(0,0,0,0.25)" }}
        onClick={() => setIsOpen(false)}
      >
        {/* Card centrata, compatta */}
        <div
          className="relative w-full max-w-xs rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden"
          style={{ animation: "popIn 0.25s ease-out" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Striscia colorata */}
          <div className="h-1" style={{ background: "linear-gradient(90deg, #4338ca, #7c3aed)" }} />

          <div className="px-5 pt-4 pb-5">
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-slate-700">
                {greeting()}{firstName ? `, ${firstName}` : ""} ⛴
              </span>
              <button
                onClick={() => setIsOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
                aria-label="Chiudi"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                  <path d="M3 3l10 10M13 3L3 13" />
                </svg>
              </button>
            </div>

            {/* Frase */}
            <p className="text-sm text-slate-600 leading-relaxed italic border-l-2 border-indigo-300 pl-3">
              &ldquo;{quote}&rdquo;
            </p>

            {/* Footer */}
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setIsOpen(false)}
                className="rounded-lg px-4 py-1.5 text-xs font-semibold text-white transition"
                style={{ background: "linear-gradient(135deg, #4338ca, #7c3aed)" }}
              >
                Inizia la giornata →
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
