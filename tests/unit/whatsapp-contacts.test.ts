import { describe, expect, it } from "vitest";
import { ensureWhatsAppContact } from "@/lib/server/whatsapp/contacts";

function makeAdmin(options: {
  existing?: { id: string; profile_name: string | null; customer_full_name?: string | null; wa_profile_name?: string | null } | null;
  insertError?: { code?: string; message: string } | null;
} = {}) {
  const calls: Array<{ type: string; payload?: unknown }> = [];
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: options.existing ?? null, error: null }),
    single: async () => ({ data: { id: "contact-new" }, error: options.insertError ?? null }),
  };
  const admin = {
    from: () => ({
      select: query.select,
      update: (payload: unknown) => {
        calls.push({ type: "update", payload });
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
      insert: (payload: unknown) => {
        calls.push({ type: "insert", payload });
        return { select: () => ({ single: query.single }) };
      },
    }),
  };
  return { admin: admin as never, calls };
}

describe("ensureWhatsAppContact", () => {
  it("crea un contatto per una prenotazione con telefono valido", async () => {
    const { admin, calls } = makeAdmin();
    const result = await ensureWhatsAppContact(admin, {
      tenantId: "tenant-1",
      phone: "3391234567",
      profileName: "Mario Rossi",
    });

    expect(result).toMatchObject({ ok: true, phoneE164: "+393391234567", waId: "393391234567", created: true });
    expect(calls[0]).toMatchObject({
      type: "insert",
      payload: expect.objectContaining({
        phone_e164: "+393391234567",
        profile_name: "Mario Rossi",
        customer_full_name: "Mario Rossi",
      }),
    });
  });

  it("salta silenziosamente numeri placeholder o mancanti", async () => {
    const { admin, calls } = makeAdmin();
    await expect(ensureWhatsAppContact(admin, { tenantId: "tenant-1", phone: "000000" })).resolves.toMatchObject({ skipped: true });
    await expect(ensureWhatsAppContact(admin, { tenantId: "tenant-1", phone: "" })).resolves.toMatchObject({ skipped: true });
    expect(calls).toEqual([]);
  });

  it("non sovrascrive un nome esistente con vuoto", async () => {
    const { admin, calls } = makeAdmin({ existing: { id: "contact-1", profile_name: "Nome Gia Presente" } });
    await ensureWhatsAppContact(admin, {
      tenantId: "tenant-1",
      phone: "+491721234567",
      profileName: "",
    });

    expect(calls[0]).toMatchObject({
      type: "update",
      payload: expect.not.objectContaining({ profile_name: expect.anything() }),
    });
  });

  it("aggiorna il nome solo se il contatto esistente non lo aveva", async () => {
    const { admin, calls } = makeAdmin({ existing: { id: "contact-1", profile_name: null } });
    await ensureWhatsAppContact(admin, {
      tenantId: "tenant-1",
      phone: "+491721234567",
      profileName: "Hilde",
    });

    expect(calls[0]).toMatchObject({
      type: "update",
      payload: expect.objectContaining({ profile_name: "Hilde", customer_full_name: "Hilde" }),
    });
  });

  it("salva il nome profilo WhatsApp in un campo separato", async () => {
    const { admin, calls } = makeAdmin({ existing: { id: "contact-1", profile_name: "Mario Rossi", customer_full_name: "Mario Rossi" } });
    await ensureWhatsAppContact(admin, {
      tenantId: "tenant-1",
      phone: "+393391234567",
      waProfileName: "Mario 😊",
    });

    expect(calls[0]).toMatchObject({
      type: "update",
      payload: expect.objectContaining({ wa_profile_name: "Mario 😊" }),
    });
    expect(calls[0]).toMatchObject({
      payload: expect.not.objectContaining({ profile_name: "Mario 😊", customer_full_name: "Mario 😊" }),
    });
  });
});
