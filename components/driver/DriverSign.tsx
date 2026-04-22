"use client";

/**
 * DriverSign — cartello digitale da mostrare al cliente all'arrivo.
 * Gruppo: solo logo ITS grande centrato.
 * Esclusivo: logo + nome cliente + hotel, stile cartello aeroportuale.
 */

import Image from "next/image";

type Props = {
  customerName: string | null;
  hotelName: string | null;
  isExclusive: boolean;
  onClose: () => void;
};

export function DriverSign({ customerName, hotelName, isExclusive, onClose }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white"
      onClick={onClose}
    >
      <div className="absolute left-0 right-0 top-0 flex items-center justify-between border-b border-slate-200 bg-white/95 px-4 py-3 shadow-sm">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="rounded-full bg-slate-900 px-4 py-2 text-sm font-bold text-white shadow-sm active:scale-95"
        >
          ← Torna ai servizi
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-lg font-bold text-slate-600 active:scale-95"
          aria-label="Chiudi cartello"
        >
          ×
        </button>
      </div>

      {isExclusive && customerName ? (
        /* ── Servizio esclusivo ── */
        <div className="flex flex-col items-center gap-8 px-8 text-center">
          <Image
            src="/brand/logo-ischia-transfer.png"
            alt="Ischia Transfer Service"
            width={160}
            height={160}
            className="object-contain"
            priority
          />
          <div className="rounded-3xl border-4 border-slate-900 px-10 py-8 shadow-2xl">
            <p className="text-5xl font-black uppercase tracking-widest text-slate-900 leading-tight">
              {customerName}
            </p>
            {hotelName && (
              <p className="mt-4 text-2xl font-semibold text-slate-500 uppercase tracking-wider">
                {hotelName}
              </p>
            )}
          </div>
          <p className="text-sm font-semibold uppercase tracking-widest text-slate-400">
            Ischia Transfer Service
          </p>
        </div>
      ) : (
        /* ── Servizio di gruppo ── */
        <div className="flex flex-col items-center gap-6 px-8 text-center">
          <Image
            src="/brand/logo-ischia-transfer.png"
            alt="Ischia Transfer Service"
            width={280}
            height={280}
            className="object-contain"
            priority
          />
          <p className="text-3xl font-black uppercase tracking-[0.15em] text-slate-800">
            Ischia Transfer Service
          </p>
        </div>
      )}
    </div>
  );
}
