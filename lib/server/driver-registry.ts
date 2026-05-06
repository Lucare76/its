import type { SupabaseClient } from "@supabase/supabase-js";

type DriverProfileRow = {
  id: string;
  tenant_id: string;
  user_id: string | null;
  full_name: string;
  phone: string | null;
  active: boolean;
};

type DriverMembershipRow = {
  user_id: string;
  tenant_id: string;
  role: string;
  full_name: string;
  username?: string | null;
  suspended: boolean | null;
  max_vehicle_capacity?: number | null;
};

export type DriverRegistryEntry = {
  id: string;
  user_id: string | null;
  full_name: string;
  phone: string | null;
  username: string | null;
  active: boolean;
  has_access: boolean;
  access_suspended: boolean;
  role: string | null;
  max_vehicle_capacity: number | null;
};

export function normalizeDriverName(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildDriverUsernameBase(fullName: string) {
  const normalized = fullName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.{2,}/g, ".");
  return normalized || "autista";
}

export function normalizeDriverPassword(phone: string | null | undefined) {
  return (phone ?? "").replace(/\s+/g, "").trim();
}

function buildInternalDriverEmail(params: { tenantId: string; username: string }) {
  return `${params.username}@ischiatransferservice.it`;
}

async function membershipsSupportUsername(admin: SupabaseClient) {
  const result = await admin.from("memberships").select("username").limit(1);
  if (!result.error) return true;
  if ((result.error as { code?: string }).code === "42703") return false;
  throw new Error(result.error.message);
}

export async function reserveMembershipUsername(
  admin: SupabaseClient,
  params: {
    preferredUsername: string;
    excludeUserId?: string | null;
  }
) {
  const base = buildDriverUsernameBase(params.preferredUsername);
  const hasUsernameColumn = await membershipsSupportUsername(admin);
  if (!hasUsernameColumn) return base;
  let candidate = base;
  let suffix = 2;

  while (true) {
    let query = admin
      .from("memberships")
      .select("user_id")
      .eq("username", candidate)
      .limit(1);

    if (params.excludeUserId) {
      query = query.neq("user_id", params.excludeUserId);
    }

    const result = await query.maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data?.user_id) {
      return candidate;
    }

    candidate = `${base}${suffix}`;
    suffix += 1;
  }
}

async function loadDriverProfiles(admin: SupabaseClient, tenantId: string, activeOnly: boolean) {
  let query = admin
    .from("driver_profiles")
    .select("id, tenant_id, user_id, full_name, phone, active")
    .eq("tenant_id", tenantId)
    .order("full_name");

  if (activeOnly) {
    query = query.eq("active", true);
  }

  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []) as DriverProfileRow[];
}

async function loadDriverMemberships(admin: SupabaseClient, tenantId: string) {
  const hasUsernameColumn = await membershipsSupportUsername(admin);
  const columns = hasUsernameColumn
    ? "user_id, tenant_id, role, full_name, username, suspended, max_vehicle_capacity"
    : "user_id, tenant_id, role, full_name, suspended, max_vehicle_capacity";
  const result = await admin
    .from("memberships")
    .select(columns)
    .eq("tenant_id", tenantId)
    .eq("role", "driver");

  if (result.error) throw new Error(result.error.message);
  return ((result.data ?? []) as unknown) as DriverMembershipRow[];
}

export async function listDriverRegistry(
  admin: SupabaseClient,
  tenantId: string,
  options?: { activeOnly?: boolean }
) {
  const activeOnly = options?.activeOnly ?? true;
  const [profiles, memberships] = await Promise.all([
    loadDriverProfiles(admin, tenantId, activeOnly),
    loadDriverMemberships(admin, tenantId),
  ]);

  const membershipByUserId = new Map(memberships.map((membership) => [membership.user_id, membership]));
  const fallbackMembershipByName = new Map<string, DriverMembershipRow>();
  for (const membership of memberships) {
    const key = normalizeDriverName(membership.full_name);
    if (key && !fallbackMembershipByName.has(key)) {
      fallbackMembershipByName.set(key, membership);
    }
  }

  return profiles.map<DriverRegistryEntry>((profile) => {
    const linkedMembership =
      (profile.user_id ? membershipByUserId.get(profile.user_id) : null) ??
      fallbackMembershipByName.get(normalizeDriverName(profile.full_name)) ??
      null;

    return {
      id: profile.id,
      user_id: profile.user_id ?? linkedMembership?.user_id ?? null,
      full_name: profile.full_name,
      phone: profile.phone,
      username: linkedMembership?.username ?? null,
      active: profile.active,
      has_access: Boolean(linkedMembership?.user_id),
      access_suspended: linkedMembership?.suspended === true,
      role: linkedMembership?.role ?? null,
      max_vehicle_capacity: linkedMembership?.max_vehicle_capacity ?? null,
    };
  });
}

export async function ensureDriverProfileForMembership(
  admin: SupabaseClient,
  params: {
    tenantId: string;
    userId: string;
    fullName: string;
    reactivate?: boolean;
  }
) {
  const { tenantId, userId, fullName, reactivate = true } = params;
  const normalizedName = normalizeDriverName(fullName);

  const existingByUser = await admin
    .from("driver_profiles")
    .select("id, user_id, full_name, active")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();

  if (existingByUser.error) throw new Error(existingByUser.error.message);

  if (existingByUser.data?.id) {
    const updateResult = await admin
      .from("driver_profiles")
      .update({
        full_name: fullName,
        active: reactivate ? true : existingByUser.data.active,
      })
      .eq("tenant_id", tenantId)
      .eq("id", existingByUser.data.id)
      .select("id")
      .maybeSingle();

    if (updateResult.error || !updateResult.data?.id) {
      throw new Error(updateResult.error?.message ?? "Aggiornamento driver profile fallito.");
    }
    return updateResult.data.id;
  }

  const profilesResult = await admin
    .from("driver_profiles")
    .select("id, user_id, full_name, active")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });

  if (profilesResult.error) throw new Error(profilesResult.error.message);

  const match = ((profilesResult.data ?? []) as Array<{ id: string; user_id: string | null; full_name: string; active: boolean }>)
    .find((profile) => !profile.user_id && normalizeDriverName(profile.full_name) === normalizedName);

  if (match?.id) {
    const linkResult = await admin
      .from("driver_profiles")
      .update({
        user_id: userId,
        full_name: fullName,
        active: reactivate ? true : match.active,
      })
      .eq("tenant_id", tenantId)
      .eq("id", match.id)
      .select("id")
      .maybeSingle();

    if (linkResult.error || !linkResult.data?.id) {
      throw new Error(linkResult.error?.message ?? "Collegamento driver profile fallito.");
    }
    return linkResult.data.id;
  }

  const insertResult = await admin
    .from("driver_profiles")
    .insert({
      tenant_id: tenantId,
      user_id: userId,
      full_name: fullName,
      active: reactivate,
    })
    .select("id")
    .maybeSingle();

  if (insertResult.error || !insertResult.data?.id) {
    throw new Error(insertResult.error?.message ?? "Creazione driver profile fallita.");
  }
  return insertResult.data.id;
}

export async function syncMembershipNameFromProfile(
  admin: SupabaseClient,
  params: { tenantId: string; userId: string; fullName: string }
) {
  const { tenantId, userId, fullName } = params;
  const result = await admin
    .from("memberships")
    .update({ full_name: fullName })
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("role", "driver");

  if (result.error) throw new Error(result.error.message);
}

export async function ensureDriverAccessForProfile(
  admin: SupabaseClient,
  params: {
    tenantId: string;
    profileId: string;
    fullName: string;
    phone: string | null;
  }
) {
  const normalizedPassword = normalizeDriverPassword(params.phone);
  if (normalizedPassword.length < 6) {
    throw new Error("Telefono autista non valido per creare l'accesso.");
  }

  const profileResult = await admin
    .from("driver_profiles")
    .select("id, user_id, full_name, phone, active")
    .eq("tenant_id", params.tenantId)
    .eq("id", params.profileId)
    .maybeSingle();

  if (profileResult.error) throw new Error(profileResult.error.message);
  if (!profileResult.data?.id) {
    throw new Error("Profilo autista non trovato.");
  }

  const hasUsernameColumn = await membershipsSupportUsername(admin);

  if (profileResult.data.user_id) {
    const membershipColumns = hasUsernameColumn ? "user_id, username" : "user_id";
    const membershipResult = await admin
      .from("memberships")
      .select(membershipColumns)
      .eq("tenant_id", params.tenantId)
      .eq("user_id", profileResult.data.user_id)
      .eq("role", "driver")
      .maybeSingle();

    if (membershipResult.error) throw new Error(membershipResult.error.message);

    const membershipData = (membershipResult.data ?? null) as ({ user_id: string; username?: string | null } | null);
    let username = membershipData?.username ?? null;
    if (!username && hasUsernameColumn) {
      username = await reserveMembershipUsername(admin, {
        preferredUsername: params.fullName,
        excludeUserId: profileResult.data.user_id,
      });
      const usernameUpdate = await admin
        .from("memberships")
        .update({ username, full_name: params.fullName, suspended: false })
        .eq("tenant_id", params.tenantId)
        .eq("user_id", profileResult.data.user_id)
        .eq("role", "driver");
      if (usernameUpdate.error) throw new Error(usernameUpdate.error.message);
    }

    return {
      userId: profileResult.data.user_id,
      username: username ?? buildDriverUsernameBase(params.fullName),
      temporaryPassword: normalizedPassword,
      created: false,
    };
  }

  const username = await reserveMembershipUsername(admin, {
    preferredUsername: params.fullName,
  });
  const email = buildInternalDriverEmail({ tenantId: params.tenantId, username });

  const authResult = await admin.auth.admin.createUser({
    email,
    password: normalizedPassword,
    email_confirm: true,
    user_metadata: {
      full_name: params.fullName,
      username,
      force_password_change: true,
      password_change_required: true,
    },
  });

  if (authResult.error || !authResult.data.user) {
    throw new Error(authResult.error?.message ?? "Creazione accesso autista fallita.");
  }

  const newUserId = authResult.data.user.id;
  const membershipInsert = await admin.from("memberships").insert({
    user_id: newUserId,
    tenant_id: params.tenantId,
    role: "driver",
    full_name: params.fullName,
    ...(hasUsernameColumn ? { username } : {}),
    suspended: false,
  });

  if (membershipInsert.error) {
    await admin.auth.admin.deleteUser(newUserId).then(() => undefined, () => undefined);
    throw new Error(membershipInsert.error.message);
  }

  try {
    await ensureDriverProfileForMembership(admin, {
      tenantId: params.tenantId,
      userId: newUserId,
      fullName: params.fullName,
    });
  } catch (error) {
    await admin.from("memberships").delete().eq("tenant_id", params.tenantId).eq("user_id", newUserId).then(() => undefined, () => undefined);
    await admin.auth.admin.deleteUser(newUserId).then(() => undefined, () => undefined);
    throw error;
  }

  return {
    userId: newUserId,
    username,
    temporaryPassword: normalizedPassword,
    created: true,
  };
}

export async function unlinkDriverProfileFromMembership(
  admin: SupabaseClient,
  params: { tenantId: string; userId: string }
) {
  const result = await admin
    .from("driver_profiles")
    .update({ user_id: null })
    .eq("tenant_id", params.tenantId)
    .eq("user_id", params.userId);

  if (result.error) throw new Error(result.error.message);
}

export async function deactivateDriverProfileAndAccess(
  admin: SupabaseClient,
  params: { tenantId: string; profileId: string }
) {
  const { tenantId, profileId } = params;
  const profileResult = await admin
    .from("driver_profiles")
    .select("id, user_id")
    .eq("tenant_id", tenantId)
    .eq("id", profileId)
    .maybeSingle();

  if (profileResult.error) throw new Error(profileResult.error.message);
  if (!profileResult.data?.id) {
    throw new Error("Profilo autista non trovato.");
  }

  const userId = profileResult.data.user_id ?? null;

  const profileUpdate = admin
    .from("driver_profiles")
    .update({ active: false })
    .eq("tenant_id", tenantId)
    .eq("id", profileId);

  const clearVehicleByProfile = admin
    .from("vehicles")
    .update({ habitual_driver_profile_id: null })
    .eq("tenant_id", tenantId)
    .eq("habitual_driver_profile_id", profileId);

  const tasks: Array<PromiseLike<{ error: { message: string } | null }>> = [
    profileUpdate,
    clearVehicleByProfile,
  ];

  if (userId) {
    tasks.push(
      admin
        .from("vehicles")
        .update({ habitual_driver_user_id: null })
        .eq("tenant_id", tenantId)
        .eq("habitual_driver_user_id", userId)
    );
    tasks.push(
      admin
        .from("memberships")
        .update({ suspended: true })
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .eq("role", "driver")
    );
  }

  const results = await Promise.all(tasks);
  const failed = results.find((result) => result.error);
  if (failed?.error) throw new Error(failed.error.message);
}
