"use client";

import { useEffect, useState } from "react";
import { getMotivationalQuote } from "@/lib/motivational-quotes";

export function MotivationalModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [quote, setQuote] = useState<string | null>(null);
  const [hasShown, setHasShown] = useState(false);

  useEffect(() => {
    // Check if modal was already shown in this session
    const modalShown = sessionStorage.getItem("motivational-modal-shown");
    if (!modalShown) {
      getMotivationalQuote()
        .then((q) => {
          setQuote(q);
          setIsOpen(true);
          sessionStorage.setItem("motivational-modal-shown", "true");
          setHasShown(true);
        })
        .catch(() => {
          setHasShown(true);
        });
    }
  }, []);

  if (!isOpen || !quote) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-md rounded-lg bg-white p-8 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-slate-800">Motivazione del giorno</h2>
        <p className="mb-6 text-base leading-relaxed text-slate-700">{quote}</p>
        <button
          onClick={() => setIsOpen(false)}
          className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 transition"
        >
          Inizia la giornata!
        </button>
      </div>
    </div>
  );
}
