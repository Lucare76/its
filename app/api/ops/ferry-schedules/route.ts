import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";

export const runtime = "nodejs";

type FerrySchedule = {
  id: string;
  company: string;
  departure_port: string;
  arrival_port: string;
  departure_time: string;
  direction: string;
  days_of_week: number[] | null;
  valid_from: string | null;
  valid_to: string | null;
  notes: string | null;
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const direction = searchParams.get("direction"); // 'ischia_to_mainland' | 'mainland_to_ischia'
  const company = searchParams.get("company");     // 'medmar' | 'snav' | 'alilauro'
  const date = searchParams.get("date");           // YYYY-MM-DD per filtrare per giorno settimana

  const admin = createAdminClient();
  let query = admin.from("ferry_schedules").select("*").order("departure_time");

  if (direction) query = query.eq("direction", direction);
  if (company) query = query.eq("company", company);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let schedules = (data ?? []) as FerrySchedule[];

  // Filtra per data se fornita
  if (date) {
    const d = new Date(date + "T12:00:00");
    const dow = d.getDay(); // 0=dom, 1=lun, ..., 6=sab
    const dateObj = new Date(date);

    schedules = schedules.filter((s) => {
      // Controlla validità date
      if (s.valid_from && new Date(s.valid_from) > dateObj) return false;
      if (s.valid_to && new Date(s.valid_to) < dateObj) return false;
      // Controlla giorni settimana
      if (s.days_of_week && s.days_of_week.length > 0) {
        return s.days_of_week.includes(dow);
      }
      return true;
    });
  }

  return NextResponse.json({ ok: true, schedules });
}
