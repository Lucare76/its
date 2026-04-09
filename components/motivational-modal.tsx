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

function formatDate() {
  return new Date().toLocaleDateString("it-IT", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
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
        setIsOpen(true);
        if (!isDev) localStorage.setItem(key, JSON.stringify({ date: today, quote: q }));
      })
      .catch(() => undefined);
  }, [storageIdentity]);

  if (!isOpen || !quote) return null;

  const firstName = firstNameOnly(userName);
  const dateStr = formatDate();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="w-full max-w-md rounded-3xl overflow-hidden shadow-2xl animate-fade-in">

        {/* Gradient top */}
        <div
          className="relative px-9 pt-10 pb-9 text-white overflow-hidden"
          style={{ background: "linear-gradient(135deg, #1e3a8a 0%, #4338ca 45%, #7c3aed 100%)" }}
        >
          {/* Cerchi decorativi */}
          <div className="absolute -top-14 -right-14 w-52 h-52 rounded-full bg-white/5" />
          <div className="absolute -bottom-10 -left-10 w-40 h-40 rounded-full bg-white/5" />

          {/* Icona traghetto */}
          <div className="absolute top-7 right-8 text-5xl select-none" style={{ filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.3))" }}>
            ⛴
          </div>

          {/* Greeting */}
          <p className="text-sm font-medium text-white/60 mb-1 relative z-10">{greeting()},</p>
          <h2 className="text-3xl font-extrabold tracking-tight relative z-10 mb-1">
            {firstName ? `${firstName} 👋` : "Benvenuto 👋"}
          </h2>
          <p className="text-xs text-white/50 relative z-10 mb-8 capitalize">{dateStr}</p>

          {/* Quote card */}
          <div
            className="relative z-10 rounded-2xl px-5 py-4"
            style={{ background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.18)", backdropFilter: "blur(8px)" }}
          >
            <span className="block text-2xl text-white/40 mb-2 leading-none">"</span>
            <p className="text-sm font-medium text-white/90 leading-relaxed italic">{quote}</p>
          </div>
        </div>

        {/* Footer bianco */}
        <div className="bg-white px-9 py-5 flex items-center justify-between">
          <p className="text-sm text-slate-400">Pronto per una grande giornata?</p>
          <button
            onClick={() => setIsOpen(false)}
            className="rounded-xl px-6 py-2.5 text-sm font-bold text-white transition"
            style={{ background: "linear-gradient(135deg, #4338ca, #7c3aed)", boxShadow: "0 4px 14px rgba(99,102,241,0.4)" }}
          >
            Inizia →
          </button>
        </div>

      </div>
    </div>
  );
}
