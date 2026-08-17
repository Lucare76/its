"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { isAllowed, isAllowedWithOverrides, type CapabilityOverrides, parseRole } from "@/lib/rbac";
import {
  AGENZIE_GROUP,
  GESTIONE_GROUP,
  HeaderBellIcon,
  KARMEN_PEACH_GROUP,
  MAIN_NAV_BY_ROLE,
  MARIO_BOSS_GROUP,
  OPERATIVO_GROUP,
  SETTINGS_GROUPS,
  canSeeNavItem,
  findNavItemByHref,
  iconWrapClass,
  loadFavorites,
  matchesPath,
  pageTitle,
  renderNavIcon,
  saveFavorites,
  uniqueNavItems
} from "@/lib/app-shell-nav";
import { ensureSupabaseClientReady, getE2ETestSessionOverride } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { needsInboxReview } from "@/lib/inbox-review";
import { MotivationalModal } from "@/components/motivational-modal";
import type { UserRole } from "@/lib/types";

export default function AppShellLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gestioneOpen, setGestioneOpen] = useState(false);
  const [agenzieOpen, setAgenzieOpen] = useState(false);
  const [operativoOpen, setOperativoOpen] = useState(false);
  const [marioBossOpen, setMarioBossOpen] = useState(false);
  const [karmenPeachOpen, setKarmenPeachOpen] = useState(false);
  const [inboxPendingCount, setInboxPendingCount] = useState(0);
  const [pendingAccessRequestCount, setPendingAccessRequestCount] = useState(0);
  const [pendingAgencyReviewCount, setPendingAgencyReviewCount] = useState(0);
  const [pendingQrReportsCount,    setPendingQrReportsCount]    = useState(0);
  const [pendingAgencyBookingsCount, setPendingAgencyBookingsCount] = useState(0);
  const [pendingCancellationsCount, setPendingCancellationsCount] = useState(0);
  const [whatsAppUnreadCount, setWhatsAppUnreadCount] = useState(0);
  const [liveToastMessage, setLiveToastMessage] = useState<string | null>(null);
  const [slaAlertMessage, setSlaAlertMessage]   = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authRole, setAuthRole] = useState<UserRole | null>(null);
  const [authGender, setAuthGender] = useState<string | null>(null);
  const [authName, setAuthName] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [authTenantId, setAuthTenantId] = useState<string | null>(null);
  const [agencySetupRequired, setAgencySetupRequired] = useState(false);
  const [capabilityOverrides, setCapabilityOverrides] = useState<CapabilityOverrides>({});
  const [quotesAccess, setQuotesAccess] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  const [passwordChangeTarget, setPasswordChangeTarget] = useState("/auth/update-password");
  const [inboxSoundEnabled, setInboxSoundEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("it-inbox-sound") === "true";
  });
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("it-theme") === "dark";
  });
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [favoritesEditMode, setFavoritesEditMode] = useState(false);
  const whatsAppSummaryInitializedRef = useRef(false);
  const latestWhatsAppMessageAtRef = useRef<string | null>(null);
  const whatsAppSummaryInFlightRef = useRef(false);
  const pathnameRef = useRef(pathname);
  const title = useMemo(() => pageTitle(pathname), [pathname]);
  const mainNav = useMemo(
    () =>
      authRole
        ? uniqueNavItems(MAIN_NAV_BY_ROLE[authRole].filter((item) => canSeeNavItem(item, authRole, quotesAccess, capabilityOverrides)))
        : [],
    [authRole, capabilityOverrides, quotesAccess]
  );
  const settingsGroups = useMemo(() => {
    if (authRole !== "admin" && authRole !== "supervisor" && authRole !== "operator") return [];
    const groups = SETTINGS_GROUPS
      .map((group) => ({
        ...group,
        items: uniqueNavItems(group.items.filter((item) => canSeeNavItem(item, authRole, quotesAccess, capabilityOverrides)))
      }))
      .filter((group) => group.items.length > 0);
    if (authRole === "operator") {
      return groups.filter((group) => group.title === "Strutture e anagrafiche");
    }
    return groups;
  }, [authRole, capabilityOverrides, quotesAccess]);
  const settingsPathActive = useMemo(
    () => settingsGroups.some((group) => group.items.some((item) => matchesPath(pathname, item.href))),
    [pathname, settingsGroups]
  );
  const isSettingsExpanded = settingsPathActive || settingsOpen;

  const redirectByRole = (role: UserRole | null) => {
    if (!role) return "/login";
    if (role === "admin" || role === "operator" || role === "supervisor") return "/dashboard";
    if (role === "driver" || role === "autista") return "/driver";
    return "/agency";
  };
  const homeHref = redirectByRole(authRole);
  const isHomePage = pathname === homeHref;

  const hardRedirect = (target: string) => {
    if (typeof window === "undefined") return;
    const current = `${window.location.pathname}${window.location.search}`;
    if (current === target) return;
    window.location.replace(target);
  };

  // Listener globale: quando il refresh token scade o è invalido Supabase emette
  // SIGNED_OUT — reindirizziamo subito al login senza aspettare runAuthCheck.
  useEffect(() => {
    if (!supabase) return;
    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        hardRedirect(`/login`);
      }
    });
    return () => { authListener.subscription.unsubscribe(); };
  }, []);

  // Identity/session resolution. Sprint Performance 12: this used to depend on
  // `pathname` and therefore re-ran its entire getUser() + getSession() +
  // /api/onboarding/tenant (+ agency-profile / settings-users / quotes-access)
  // chain on every client-side navigation, even though this layout component
  // never unmounts between pages in the same (app) route group. It now runs
  // once per mount — pathname-dependent decisions (redirects) are handled by
  // the separate route-gating effect below, which reads the state resolved
  // here instead of re-fetching anything.
  useEffect(() => {
    let active = true;

    const runAuthCheck = async () => {
      const e2eOverride = getE2ETestSessionOverride();
      if (e2eOverride) {
        if (!active) return;
        setNeedsOnboarding(false);
        setPasswordChangeRequired(false);
        setAuthRole(e2eOverride.role);
        setAuthTenantId(e2eOverride.tenantId);
        setAgencySetupRequired(false);
        setCapabilityOverrides({});
        setQuotesAccess(e2eOverride.role === "admin" || e2eOverride.role === "supervisor" || e2eOverride.role === "operator");
        setAuthLoading(false);
        return;
      }

      if (!hasSupabaseEnv || !supabase) {
        if (!active) return;
        setNeedsOnboarding(false);
        setAuthRole(null);
        setAuthTenantId(null);
        setAgencySetupRequired(false);
        setCapabilityOverrides({});
        setQuotesAccess(false);
        setAuthLoading(false);
        hardRedirect(`/login?redirect=${encodeURIComponent(pathnameRef.current)}`);
        return;
      }

      // Fast path: check localStorage synchronously before touching the Supabase
      // client. navigator.locks.request() (used internally by getUser) can block
      // indefinitely when no session exists, causing "Verifica sessione..." to hang.
      // If storage has no auth token we know there is no active session.
      const hasStoredSession = (() => {
        try {
          return Object.keys(localStorage).some(
            (k) => k.endsWith("-auth-token") && !!localStorage.getItem(k)
          );
        } catch { return false; }
      })();
      if (!hasStoredSession) {
        if (!active) return;
        setNeedsOnboarding(false);
        setAuthRole(null);
        setAuthTenantId(null);
        setAgencySetupRequired(false);
        setCapabilityOverrides({});
        setQuotesAccess(false);
        setAuthLoading(false);
        hardRedirect(`/login?redirect=${encodeURIComponent(pathnameRef.current)}`);
        return;
      }

      await ensureSupabaseClientReady();
      if (!active) return;

      const { data: userData, error: userError } = await Promise.race([
        supabase.auth.getUser(),
        new Promise<{ data: { user: null }; error: null }>((resolve) => {
          setTimeout(() => resolve({ data: { user: null }, error: null }), 8000);
        }),
      ]) as Awaited<ReturnType<typeof supabase.auth.getUser>>;
      if (!active) return;
      if (userError || !userData.user) {
        const isMissingSession = !userError || (userError as { name?: string }).name === "AuthSessionMissingError";
        if (!isMissingSession) {
          await Promise.race([
            supabase.auth.signOut().catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, 2000)),
          ]);
        }
        if (!active) return;
        setNeedsOnboarding(false);
        setAuthRole(null);
        setAuthTenantId(null);
        setAgencySetupRequired(false);
        setCapabilityOverrides({});
        setQuotesAccess(false);
        setAuthLoading(false);
        hardRedirect(`/login?redirect=${encodeURIComponent(pathnameRef.current)}`);
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!active) return;
      if (!accessToken) {
        setNeedsOnboarding(false);
        setAuthRole(null);
        setAuthTenantId(null);
        setAgencySetupRequired(false);
        setCapabilityOverrides({});
        setQuotesAccess(false);
        setAuthLoading(false);
        hardRedirect(`/login?redirect=${encodeURIComponent(pathnameRef.current)}`);
        return;
      }

      const userMetadata = userData.user.user_metadata ?? {};
      const isPasswordChangeRequired = userMetadata.password_change_required === true;
      const driverPasswordChangeRequired = userMetadata.force_password_change === true;
      const resolvedPasswordChangeTarget = driverPasswordChangeRequired ? "/driver/change-password" : "/auth/update-password";
      if (isPasswordChangeRequired || driverPasswordChangeRequired) {
        setPasswordChangeRequired(true);
        setPasswordChangeTarget(resolvedPasswordChangeTarget);
        if (pathnameRef.current !== resolvedPasswordChangeTarget) {
          hardRedirect(resolvedPasswordChangeTarget);
          return;
        }
      } else {
        setPasswordChangeRequired(false);
      }

      const onboardingResponse = await fetch("/api/onboarding/tenant", {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });
      const onboardingPayload = (await onboardingResponse.json().catch(() => null)) as
        | { hasTenant?: boolean; tenant?: { id: string }; role?: string; error?: string; capability_overrides?: CapabilityOverrides }
        | null;
      if (!active) return;

      if (onboardingResponse.status === 403) {
        await supabase.auth.signOut().catch(() => undefined);
        setNeedsOnboarding(false);
        setAuthRole(null);
        setAuthTenantId(null);
        setAgencySetupRequired(false);
        setCapabilityOverrides({});
        setQuotesAccess(false);
        setAuthLoading(false);
        hardRedirect("/login?suspended=1");
        return;
      }

      const resolvedRole = parseRole(onboardingPayload?.role);
      const resolvedTenantId = onboardingPayload?.tenant?.id ?? null;
      const hasTenant = Boolean(onboardingPayload?.hasTenant && resolvedRole && resolvedTenantId);

      if (!hasTenant) {
        setNeedsOnboarding(true);
        setAuthRole(null);
        setAuthTenantId(null);
        setAgencySetupRequired(false);
        setCapabilityOverrides({});
        setQuotesAccess(false);
        setAuthLoading(false);
        return;
      }

      setNeedsOnboarding(false);
      setAuthRole(resolvedRole);
      setAuthUserId(userData.user.id);
      setAuthGender(typeof userData.user.user_metadata?.gender === "string" ? userData.user.user_metadata.gender : null);
      setAuthName(typeof userData.user.user_metadata?.full_name === "string" ? userData.user.user_metadata.full_name : null);
      setAuthEmail(typeof userData.user.email === "string" ? userData.user.email : null);
      setAuthTenantId(resolvedTenantId);
      setCapabilityOverrides(onboardingPayload?.capability_overrides ?? {});
      let resolvedAgencySetupRequired = false;
      if (resolvedRole === "agency") {
        const agencyProfileResponse = await fetch("/api/agency/profile", {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        const agencyProfilePayload = (await agencyProfileResponse.json().catch(() => null)) as
          | { agency?: { setup_required?: boolean } }
          | null;
        if (!active) return;
        resolvedAgencySetupRequired = agencyProfileResponse.ok && agencyProfilePayload?.agency?.setup_required === true;
      }
      setAgencySetupRequired(resolvedAgencySetupRequired);
      if (resolvedRole === "admin" || resolvedRole === "supervisor") {
        const pendingAccessResponse = await fetch("/api/settings/users", {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        const pendingAccessPayload = (await pendingAccessResponse.json().catch(() => null)) as
          | { pending_access_requests?: Array<unknown> }
          | null;
        if (!active) return;
        setPendingAccessRequestCount(pendingAccessResponse.ok ? pendingAccessPayload?.pending_access_requests?.length ?? 0 : 0);
      } else {
        setPendingAccessRequestCount(0);
      }
      let resolvedQuotesAccess = resolvedRole === "admin" || resolvedRole === "supervisor";
      if (resolvedRole === "operator") {
        const quotesAccessResponse = await fetch("/api/ops/quotes/access", {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        const quotesAccessPayload = (await quotesAccessResponse.json().catch(() => null)) as
          | { ok?: boolean; can_access?: boolean }
          | null;
        if (!active) return;
        resolvedQuotesAccess = quotesAccessResponse.ok && quotesAccessPayload?.ok === true && quotesAccessPayload.can_access === true;
      }
      setQuotesAccess(resolvedQuotesAccess);
      setAuthLoading(false);
    };

    void runAuthCheck();
    return () => {
      active = false;
    };
    // Intentionally NOT depending on pathname/router: this chain resolves
    // identity/tenant once per mount. Auth failures inside it hardRedirect via
    // a full page load (window.location.replace), which remounts the layout
    // and naturally re-runs this effect — no pathname dependency needed for
    // correctness. See the route-gating effect below for pathname-reactive
    // redirects that reuse the state resolved here without re-fetching.
  }, []);

  // Route-dependent redirect gating. Runs on every pathname change (real
  // client-side navigation) but performs no getUser/getSession/onboarding-
  // tenant calls — it only reacts to the identity state the effect above
  // already resolved and cached. This is what keeps navigation between
  // authenticated pages from re-triggering a full session/tenant resolution.
  useEffect(() => {
    if (authLoading) return;
    if (needsOnboarding) {
      if (pathname !== "/onboarding") hardRedirect("/onboarding");
      return;
    }
    if (authRole === "agency" && agencySetupRequired && pathname !== "/agency/profile-setup") {
      hardRedirect("/agency/profile-setup");
      return;
    }
    if (authRole === "agency" && !agencySetupRequired && pathname === "/agency/profile-setup") {
      hardRedirect("/agency");
      return;
    }
    if (authRole !== "admin" && authRole !== "supervisor" && pathname.startsWith("/preventivo-ops") && !quotesAccess) {
      hardRedirect(redirectByRole(authRole));
      return;
    }
    if (!isAllowedWithOverrides(pathname, authRole, capabilityOverrides)) {
      hardRedirect(redirectByRole(authRole));
    }
  }, [pathname, authLoading, needsOnboarding, authRole, agencySetupRequired, quotesAccess, capabilityOverrides]);

  useEffect(() => {
    if (!collapsed) return;
    const timeout = window.setTimeout(() => {
      setSettingsOpen(false);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [collapsed]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", isDark);
    root.classList.toggle("light", !isDark);
  }, [isDark]);

  useEffect(() => {
    if (!liveToastMessage) return;
    const timeout = window.setTimeout(() => setLiveToastMessage(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [liveToastMessage]);

  useEffect(() => {
    if (!slaAlertMessage) return;
    const timeout = window.setTimeout(() => setSlaAlertMessage(null), 30_000);
    return () => window.clearTimeout(timeout);
  }, [slaAlertMessage]);

  const playInboxSound = () => {
    if (typeof window === "undefined") return;
    const audio = new Audio("/mario.mp3");
    audio.currentTime = 0;
    audio.play().then(() => {
      window.setTimeout(() => { audio.pause(); audio.currentTime = 0; }, 2200);
    }).catch(() => { /* autoplay bloccato */ });
  };

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (!authTenantId || !["admin", "operator", "supervisor"].includes(authRole ?? "")) {
      whatsAppSummaryInitializedRef.current = false;
      latestWhatsAppMessageAtRef.current = null;
      return;
    }
    let isActive = true;

    const refreshWhatsAppSummary = async () => {
      // Il tab in background non ha bisogno di badge/notifiche in tempo reale:
      // evitiamo di interrogare Supabase finché l'utente non torna sulla pagina.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      // Evita fetch sovrapposti (es. tick dell'intervallo + refresh da visibilitychange).
      if (whatsAppSummaryInFlightRef.current) return;
      whatsAppSummaryInFlightRef.current = true;
      try {
        const { data: sessionData } = await supabase!.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) return;
        const response = await fetch("/api/ops/whatsapp-inbox/summary", {
          headers: { authorization: `Bearer ${token}` },
          cache: "no-store"
        });
        if (!response.ok) return;
        const payload = await response.json() as {
          unread_count?: number;
          latest_message_at?: string | null;
          latest_sender?: string | null;
          latest_preview?: string | null;
        };
        if (!isActive) return;

        const previousLatest = latestWhatsAppMessageAtRef.current;
        const nextLatest = payload.latest_message_at ?? null;
        const initialized = whatsAppSummaryInitializedRef.current;
        const unreadCount = Number(payload.unread_count ?? 0);

        setWhatsAppUnreadCount(unreadCount);
        latestWhatsAppMessageAtRef.current = nextLatest;
        whatsAppSummaryInitializedRef.current = true;

        if (initialized && nextLatest && nextLatest !== previousLatest && unreadCount > 0 && pathnameRef.current !== "/whatsapp") {
          const sender = payload.latest_sender ? ` da ${payload.latest_sender}` : "";
          const preview = payload.latest_preview ? `: ${payload.latest_preview}` : "";
          setLiveToastMessage(`Nuovo messaggio WhatsApp${sender}${preview}`.slice(0, 180));
          if (inboxSoundEnabled) playInboxSound();
        }
      } catch {
        // Notifica non critica: se fallisce manteniamo l'ultimo stato noto e riproviamo al prossimo polling.
      } finally {
        whatsAppSummaryInFlightRef.current = false;
      }
    };

    void refreshWhatsAppSummary();
    const interval = window.setInterval(refreshWhatsAppSummary, 30_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshWhatsAppSummary();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      isActive = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // pathname NON è più una dipendenza: il polling globale non deve riavviarsi
    // ad ogni cambio pagina. Il valore aggiornato di pathname è letto da
    // pathnameRef (vedi effect sopra), così il controllo "non mostrare il toast
    // se sono già su /whatsapp" resta corretto senza far ripartire l'intervallo.
  }, [authRole, authTenantId, inboxSoundEnabled]);

  const playSlaAlarm = () => {
    if (typeof window === "undefined") return;
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "square";
      // Pattern sirena: alto → basso × 3
      const t = ctx.currentTime;
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.setValueAtTime(440, t + 0.25);
      osc.frequency.setValueAtTime(880, t + 0.5);
      osc.frequency.setValueAtTime(440, t + 0.75);
      osc.frequency.setValueAtTime(880, t + 1.0);
      osc.frequency.setValueAtTime(440, t + 1.25);
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
      osc.start(t);
      osc.stop(t + 1.6);
    } catch { /* AudioContext non disponibile */ }
  };

  // Trasforma in maiuscolo tutti i campi testo mentre si digita
  useEffect(() => {
    const SKIP_TYPES = new Set(["password", "email", "number", "date", "time", "datetime-local", "range", "color", "checkbox", "radio", "file", "hidden", "submit", "button", "reset", "image", "url"]);
    const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

    const handleInput = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.closest(".quote-natural-text")) return;
      if (target instanceof HTMLInputElement) {
        if (SKIP_TYPES.has(target.type) || target.dataset.noUppercase) return;
        const upper = target.value.toUpperCase();
        if (upper === target.value) return;
        const start = target.selectionStart;
        const end = target.selectionEnd;
        inputSetter?.call(target, upper);
        target.setSelectionRange(start, end);
        target.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (target instanceof HTMLTextAreaElement) {
        if (target.dataset.noUppercase) return;
        const upper = target.value.toUpperCase();
        if (upper === target.value) return;
        const start = target.selectionStart;
        const end = target.selectionEnd;
        textareaSetter?.call(target, upper);
        target.setSelectionRange(start, end);
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };

    document.addEventListener("input", handleInput, true);
    return () => document.removeEventListener("input", handleInput, true);
  }, []);

  // Ascolta alert SLA dal service worker via BroadcastChannel
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!["admin", "operator", "supervisor"].includes(authRole ?? "")) return;
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("its-sla");
      bc.onmessage = (event) => {
        if (event.data?.type === "sla_alert") {
          setSlaAlertMessage(event.data.body || "Servizio senza autista nelle prossime 12 ore!");
          playSlaAlarm();
        }
      };
    } catch { /* BroadcastChannel non supportato */ }
    return () => { bc?.close(); };
  }, [authRole]);

  useEffect(() => {
    const client = supabase;
    if (!hasSupabaseEnv || !client || !authTenantId) return;

    let isActive = true;

    const refreshPendingCount = async (tenantId: string) => {
      const { data, error } = await client
        .from("inbound_emails")
        .select("id, parsed_json")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(2000);
      if (!isActive || error) return;
      const rows = (data ?? []) as Array<{ parsed_json: unknown }>;
      setInboxPendingCount(rows.filter((row) => needsInboxReview(row.parsed_json)).length);
    };

    const refreshAgencyReviewCount = async (tenantId: string) => {
      const { count } = await client
        .from("agency_review_sessions")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "modified");
      if (isActive) setPendingAgencyReviewCount(count ?? 0);
    };

    const refreshQrReportsCount = async (tenantId: string) => {
      // Recupera id veicoli del tenant, poi conta open reports
      const { data: vids } = await client
        .from("vehicles")
        .select("id")
        .eq("tenant_id", tenantId);
      if (!vids?.length) { if (isActive) setPendingQrReportsCount(0); return; }
      const { count } = await client
        .from("vehicle_qr_reports")
        .select("id", { count: "exact", head: true })
        .eq("status", "open")
        .in("vehicle_id", vids.map((v) => v.id));
      if (isActive) setPendingQrReportsCount(count ?? 0);
    };

    const refreshPendingAgencyBookings = async (tenantId: string) => {
      if (authRole !== "admin" && authRole !== "operator") {
        setPendingAgencyBookingsCount(0);
        return;
      }
      const { count } = await client
        .from("services")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("approval_status", "pending_operator");
      if (isActive) setPendingAgencyBookingsCount(count ?? 0);
    };

    const refreshPendingCancellations = async (tenantId: string) => {
      if (authRole !== "admin" && authRole !== "operator") {
        setPendingCancellationsCount(0);
        return;
      }
      const { count } = await client
        .from("cancellation_requests")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["pending_review", "pending_agency_approval"]);
      if (isActive) setPendingCancellationsCount(count ?? 0);
    };

    const refreshPendingAccessRequests = async (tenantId: string) => {
      if (authRole !== "admin") {
        setPendingAccessRequestCount(0);
        return;
      }
      const { count, error } = await client
        .from("tenant_access_requests")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "pending");
      if (!isActive || error) return;
      setPendingAccessRequestCount(count ?? 0);
    };

    const initRealtime = async () => {
      const tenantId = authTenantId;
      await refreshPendingCount(tenantId);
      await refreshPendingAccessRequests(tenantId);
      await refreshAgencyReviewCount(tenantId);
      await refreshQrReportsCount(tenantId);
      await refreshPendingAgencyBookings(tenantId);
      await refreshPendingCancellations(tenantId);

      const channel = client
        .channel(`layout-inbox-${tenantId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "inbound_emails", filter: `tenant_id=eq.${tenantId}` },
          () => {
            setLiveToastMessage("Nuova email ricevuta in inbox: da revisionare.");
            if (inboxSoundEnabled) playInboxSound();
            void refreshPendingCount(tenantId);
          }
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "inbound_emails", filter: `tenant_id=eq.${tenantId}` },
          () => {
            void refreshPendingCount(tenantId);
          }
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "tenant_access_requests", filter: `tenant_id=eq.${tenantId}` },
          (payload) => {
            const nextStatus = typeof payload.new?.status === "string" ? payload.new.status : null;
            if (nextStatus === "pending") {
              setLiveToastMessage("Nuova richiesta accesso agenzia da approvare.");
            }
            void refreshPendingAccessRequests(tenantId);
          }
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "tenant_access_requests", filter: `tenant_id=eq.${tenantId}` },
          () => {
            void refreshPendingAccessRequests(tenantId);
          }
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "agency_review_sessions", filter: `tenant_id=eq.${tenantId}` },
          () => {
            void refreshAgencyReviewCount(tenantId);
          }
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "agency_review_sessions", filter: `tenant_id=eq.${tenantId}` },
          (payload) => {
            const status = typeof payload.new?.status === "string" ? payload.new.status : null;
            if (status === "modified") {
              const agency = typeof payload.new?.agency_name === "string" ? payload.new.agency_name : "Agenzia";
              setLiveToastMessage(`✏️ ${agency} ha segnalato modifiche al riepilogo.`);
            }
            void refreshAgencyReviewCount(tenantId);
          }
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "vehicle_qr_reports" },
          (payload) => {
            setLiveToastMessage(`🚨 Nuova segnalazione danno veicolo ricevuta.`);
            void refreshQrReportsCount(tenantId);
          }
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "services", filter: `tenant_id=eq.${tenantId}` },
          (payload) => {
            const approvalStatus = typeof payload.new?.approval_status === "string" ? payload.new.approval_status : null;
            if (approvalStatus === "pending_operator") {
              const customerName = typeof payload.new?.customer_name === "string" ? payload.new.customer_name : null;
              setLiveToastMessage(`🏨 Nuova prenotazione agenzia${customerName ? ` — ${customerName}` : ""} in attesa di approvazione.`);
              void refreshPendingAgencyBookings(tenantId);
            }
          }
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "services", filter: `tenant_id=eq.${tenantId}` },
          (payload) => {
            const newStatus = typeof payload.new?.approval_status === "string" ? payload.new.approval_status : null;
            const oldStatus = typeof payload.old?.approval_status === "string" ? payload.old.approval_status : null;
            if (newStatus !== oldStatus) void refreshPendingAgencyBookings(tenantId);
          }
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "cancellation_requests", filter: `tenant_id=eq.${tenantId}` },
          () => {
            setLiveToastMessage("✕ Nuova richiesta di cancellazione ricevuta.");
            void refreshPendingCancellations(tenantId);
          }
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "cancellation_requests", filter: `tenant_id=eq.${tenantId}` },
          () => {
            void refreshPendingCancellations(tenantId);
          }
        );

      channel.subscribe();
      return channel;
    };

    let activeChannel: ReturnType<typeof client.channel> | null = null;
    void initRealtime().then((channel) => {
      if (!channel || !isActive) return;
      activeChannel = channel;
    });

    return () => {
      isActive = false;
      if (activeChannel) {
        void client.removeChannel(activeChannel);
      }
    };
  }, [authRole, authTenantId, inboxSoundEnabled]);

  // Sprint Performance 8: il polling IMAP automatico dal layout globale è
  // stato rimosso. L'import email ora passa solo dal cron centralizzato
  // (/api/cron/poll-emails) e dal refresh manuale in Inbox, entrambi tramite
  // lo stesso lock/cooldown condiviso (lib/server/email-poll.ts). Il layout
  // non apre più connessioni IMAP.

  // Carica preferiti quando userId è disponibile
  // NOTA: deve stare qui, prima dei return condizionali, per rispettare le regole degli hook
  useEffect(() => {
    if (!authUserId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFavorites(loadFavorites(authUserId));
  }, [authUserId]);

  if (authLoading) {
    return <div className="card p-4 text-sm text-muted">Verifica sessione...</div>;
  }

  if (needsOnboarding && pathname !== "/onboarding") {
    return <div className="card p-4 text-sm text-muted">Reindirizzamento onboarding in corso...</div>;
  }

  if (authRole === "agency" && agencySetupRequired && pathname !== "/agency/profile-setup") {
    return <div className="card p-4 text-sm text-muted">Reindirizzamento al completamento profilo agenzia...</div>;
  }

  if (!needsOnboarding && !isAllowedWithOverrides(pathname, authRole, capabilityOverrides)) {
    return <div className="card p-4 text-sm text-muted">Reindirizzamento in corso...</div>;
  }

  const toggleFavorite = (href: string) => {
    if (!authUserId) return;
    setFavorites((prev) => {
      const next = prev.includes(href) ? prev.filter((h) => h !== href) : [...prev, href];
      saveFavorites(authUserId, next);
      return next;
    });
  };

  const toggleTheme = () => {
    const nextDark = !isDark;
    setIsDark(nextDark);
    localStorage.setItem("it-theme", nextDark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", nextDark);
    document.documentElement.classList.toggle("light", !nextDark);
  };

  const toggleInboxSound = () => {
    const next = !inboxSoundEnabled;
    setInboxSoundEnabled(next);
    localStorage.setItem("it-inbox-sound", next ? "true" : "false");
    if (next) playInboxSound();
  };

  const handleSignOut = async () => {
    if (supabase) {
      await supabase.auth.signOut().catch(() => undefined);
    }
    router.replace("/login");
    router.refresh();
  };

  return (
    <>
      <section className={`grid min-h-screen w-full max-w-none grid-cols-1 gap-5 px-3 py-4 sm:px-4 md:py-5 lg:px-5 xl:px-6 ${authRole === "driver" || authRole === "autista" ? "" : "md:grid-cols-[auto_minmax(0,1fr)] md:gap-5"}`}>
      <aside className={`sticky top-5 h-fit transition-all duration-200 ${authRole === "driver" || authRole === "autista" ? "hidden" : `hidden md:block ${collapsed ? "w-[72px]" : "w-[280px]"}`}`}>
        <div className="overflow-hidden rounded-[26px] border border-slate-800 bg-[#082b4c] p-3 shadow-[0_18px_45px_rgba(8,43,76,0.22)]">

          {/* Brand + collapse */}
          <div className="mb-4 flex items-center justify-between gap-2 rounded-2xl px-2.5 py-3 text-white" style={{ background: "linear-gradient(135deg,#0b365d,#312e81,#5b21b6)" }}>
            {!collapsed ? (
              <div className="min-w-0 flex-1 px-1 py-1">
                <Image src="/Logo its.png" alt="Ischia Transfer Service" width={174} height={56} className="h-auto w-full object-contain" priority />
              </div>
            ) : (
              <div className="mx-auto flex h-9 w-9 items-center justify-center overflow-hidden">
                <Image src="/brand/logo-ischia-transfer.png" alt="Ischia Transfer" width={36} height={36} className="h-full w-full object-contain" />
              </div>
            )}
            <button
              type="button"
              onClick={() => setCollapsed((prev) => !prev)}
              className="flex-shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-white/15 text-white/80 transition hover:bg-white/25 hover:text-white"
              title={collapsed ? "Espandi menu" : "Comprimi menu"}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3" aria-hidden="true">
                {collapsed
                  ? <path d="M6 3.5l4 4.5-4 4.5" />
                  : <path d="M10 3.5L6 8l4 4.5" />}
              </svg>
            </button>
          </div>

          {/* Main nav */}
          <nav className="app-sidebar-scroll space-y-0.5 pr-0.5">

            {/* ── Preferiti ─────────────────────────────────────────── */}
            {!collapsed && favorites.length > 0 ? (
              <>
                <p className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-500">Preferiti</p>
                {favorites.map((href) => {
                  const item = findNavItemByHref(href);
                  if (!item || !canSeeNavItem(item, authRole, quotesAccess, capabilityOverrides)) return null;
                  const active = matchesPath(pathname, href);
                  return (
                    <div key={href} className="group/fav relative">
                      <Link
                        href={href}
                        className={`flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 pr-8 transition ${
                          active
                            ? "bg-slate-900 text-white"
                            : "text-slate-200 hover:bg-white/10 hover:text-white"
                        }`}
                      >
                        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center transition">
                          <span className={iconWrapClass(active)}>{renderNavIcon(item.icon)}</span>
                        </span>
                        <span className={`truncate text-sm ${active ? "font-semibold" : "font-medium"}`}>{item.label}</span>
                      </Link>
                      <button
                        type="button"
                        onClick={() => toggleFavorite(href)}
                        title="Rimuovi dai preferiti"
                        className="absolute right-2 top-1/2 -translate-y-1/2 z-10 text-amber-400 hover:text-rose-500 transition-colors opacity-0 group-hover/fav:opacity-100"
                      >
                        ★
                      </button>
                    </div>
                  );
                })}
                <div className="my-1.5 border-t border-amber-100" />
              </>
            ) : null}

            {!collapsed ? (
              <p className="px-3 pb-1.5 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Operativo</p>
            ) : null}
            {mainNav.map((item) => {
              const active = matchesPath(pathname, item.href);
              const badge = item.href === "/inbox" && inboxPendingCount > 0
                ? inboxPendingCount
                : item.href === "/whatsapp" && whatsAppUnreadCount > 0
                ? whatsAppUnreadCount
                : item.href === "/cancellazioni" && pendingCancellationsCount > 0
                ? pendingCancellationsCount
                : 0;
              const isFav = favorites.includes(item.href);
              return (
                <div key={item.href} className="group/fav relative">
                  <Link
                    href={item.href}
                    title={collapsed ? item.label : undefined}
                    className={`relative flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 transition ${
                      active
                        ? "bg-slate-900 text-white"
                        : "text-slate-200 hover:bg-white/10 hover:text-white"
                    } ${collapsed ? "justify-center" : !collapsed && badge === 0 && (isFav || favoritesEditMode) ? "pr-8" : ""}`}
                  >
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center transition">
                    <span className={iconWrapClass(active)}>{renderNavIcon(item.icon)}</span>
                  </span>
                  {!collapsed ? (
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                      <span className={`min-w-0 whitespace-nowrap text-[13px] ${active ? "font-semibold" : "font-medium"}`}>{item.label}</span>
                      {badge > 0 ? (
                        <span className="inline-flex min-w-6 shrink-0 items-center justify-center rounded-full bg-rose-600 px-1.5 py-1 text-[10px] font-semibold text-white">
                          🔔 {badge > 99 ? "99+" : badge}
                        </span>
                      ) : null}
                    </span>
                  ) : badge > 0 ? (
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-600 text-[9px] font-semibold text-white">
                      {badge > 9 ? "9+" : badge}
                    </span>
                  ) : null}
                  </Link>
                  {!collapsed && badge === 0 && (isFav || favoritesEditMode) ? (
                    <button
                      type="button"
                      onClick={() => toggleFavorite(item.href)}
                      title={isFav ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti"}
                      className={`absolute right-2 top-1/2 -translate-y-1/2 z-10 transition-all ${
                        isFav
                          ? "text-amber-400 hover:text-rose-500 opacity-100"
                          : "text-slate-300 hover:text-amber-400 opacity-0 group-hover/fav:opacity-100"
                      }`}
                    >
                      {isFav ? "★" : "☆"}
                    </button>
                  ) : null}
                </div>
              );
            })}

            {/* Gestione — gruppo collassabile */}
            {(authRole === "admin" || authRole === "supervisor" || authRole === "operator") && (() => {
              const groupActive = GESTIONE_GROUP.items.some((i) => matchesPath(pathname, i.href));
              const isExpanded = groupActive || gestioneOpen;
              const groupBadge = pendingCancellationsCount > 0 ? pendingCancellationsCount : 0;
              return (
                <div className="mt-2 border-t border-white/10 pt-2">
                  <button
                    type="button"
                    title={collapsed ? GESTIONE_GROUP.label : undefined}
                    onClick={() => { if (!collapsed) setGestioneOpen((v) => !v); }}
                    className={`group relative flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                      groupActive
                        ? "bg-gradient-to-r from-indigo-600/85 to-violet-600/75 text-white"
                        : "text-slate-200 hover:bg-white/10 hover:text-white"
                    } ${collapsed ? "justify-center" : ""}`}
                  >
                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center transition">
                      {renderNavIcon(GESTIONE_GROUP.icon)}
                    </span>
                    {!collapsed ? (
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-1">
                        <span className="truncate text-sm font-semibold uppercase tracking-[0.08em]">{GESTIONE_GROUP.label}</span>
                        <span className="flex items-center gap-1.5">
                          {groupBadge > 0 && !isExpanded ? (
                            <span className="inline-flex items-center rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                              {groupBadge > 99 ? "99+" : groupBadge}
                            </span>
                          ) : null}
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-3 w-3 shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`} aria-hidden="true">
                            <path d="M6 3.5l4 4.5-4 4.5" />
                          </svg>
                        </span>
                      </span>
                    ) : groupBadge > 0 ? (
                      <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-600 text-[9px] font-semibold text-white">
                        {groupBadge > 9 ? "9+" : groupBadge}
                      </span>
                    ) : null}
                  </button>
                  {!collapsed && isExpanded && (
                    <div className="ml-4 mt-1 space-y-0.5 border-l-2 border-indigo-400/30 pl-2">
                      {GESTIONE_GROUP.items.map((item) => {
                        const active = matchesPath(pathname, item.href);
                        const isFav = favorites.includes(item.href);
                        const itemBadge = item.href === "/cancellazioni" && pendingCancellationsCount > 0 ? pendingCancellationsCount : 0;
                        return (
                          <div key={item.href} className="group/fav relative">
                            <Link href={item.href}
                              className={`flex min-w-0 items-center gap-2.5 rounded-xl border px-2 py-1.5 text-sm transition ${
                                active ? "bg-indigo-600 text-white font-semibold" : "border-transparent text-slate-200 hover:bg-white/10 hover:text-white"
                              } ${isFav || favoritesEditMode ? "pr-7" : ""}`}
                            >
                              <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center transition ${active ? "text-white" : "text-slate-400"}`}>
                                {renderNavIcon(item.icon)}
                              </span>
                              <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                                <span className="truncate">{item.label}</span>
                                {itemBadge > 0 ? <span className="inline-flex items-center rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">{itemBadge > 99 ? "99+" : itemBadge}</span> : null}
                              </span>
                            </Link>
                            {isFav || favoritesEditMode ? (
                              <button type="button" onClick={() => toggleFavorite(item.href)}
                                title={isFav ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti"}
                                className={`absolute right-1.5 top-1/2 -translate-y-1/2 z-10 text-xs transition-all ${isFav ? "text-amber-400 hover:text-rose-500 opacity-100" : "text-slate-300 hover:text-amber-400 opacity-0 group-hover/fav:opacity-100"}`}
                              >{isFav ? "★" : "☆"}</button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Agenzie — gruppo collassabile */}
            {(authRole === "admin" || authRole === "supervisor" || authRole === "operator") && (() => {
              const groupActive = AGENZIE_GROUP.items.some((i) => matchesPath(pathname, i.href));
              const isExpanded = groupActive || agenzieOpen;
              const groupBadge = (pendingAgencyBookingsCount > 0 ? pendingAgencyBookingsCount : 0) + (pendingAgencyReviewCount > 0 ? pendingAgencyReviewCount : 0);
              return (
                <div className="mt-0.5">
                  <button
                    type="button"
                    title={collapsed ? AGENZIE_GROUP.label : undefined}
                    onClick={() => { if (!collapsed) setAgenzieOpen((v) => !v); }}
                    className={`group relative flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                      groupActive
                        ? "bg-gradient-to-r from-indigo-600/85 to-violet-600/75 text-white"
                        : "text-slate-200 hover:bg-white/10 hover:text-white"
                    } ${collapsed ? "justify-center" : ""}`}
                  >
                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center transition">
                      {renderNavIcon("C")}
                    </span>
                    {!collapsed ? (
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-1">
                        <span className="truncate text-sm font-medium">{AGENZIE_GROUP.label}</span>
                        <span className="flex items-center gap-1.5">
                          {groupBadge > 0 && !isExpanded ? (
                            <span className="inline-flex items-center rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                              {groupBadge > 99 ? "99+" : groupBadge}
                            </span>
                          ) : null}
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-3 w-3 shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`} aria-hidden="true">
                            <path d="M6 3.5l4 4.5-4 4.5" />
                          </svg>
                        </span>
                      </span>
                    ) : groupBadge > 0 ? (
                      <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-600 text-[9px] font-semibold text-white">
                        {groupBadge > 9 ? "9+" : groupBadge}
                      </span>
                    ) : null}
                  </button>
                  {!collapsed && isExpanded && (
                    <div className="ml-4 mt-0.5 space-y-0.5 border-l-2 border-indigo-100 pl-2">
                      {AGENZIE_GROUP.items.map((item) => {
                        const active = matchesPath(pathname, item.href);
                        const isFav = favorites.includes(item.href);
                        const itemBadge = item.href === "/agency-requests" && pendingAgencyBookingsCount > 0
                          ? pendingAgencyBookingsCount
                          : item.href === "/inbox/agency-reviews" && pendingAgencyReviewCount > 0
                            ? pendingAgencyReviewCount : 0;
                        return (
                          <div key={item.href} className="group/fav relative">
                            <Link href={item.href}
                              className={`flex min-w-0 items-center gap-2.5 rounded-xl border px-2 py-1.5 text-sm transition ${
                                active ? "bg-slate-900 text-white font-semibold" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                              } ${isFav || favoritesEditMode ? "pr-7" : ""}`}
                            >
                              <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center transition ${active ? "text-white" : "text-slate-400"}`}>
                                {renderNavIcon(item.icon)}
                              </span>
                              <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                                <span className="truncate">{item.label}</span>
                                {itemBadge > 0 ? <span className="inline-flex items-center rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">{itemBadge > 99 ? "99+" : itemBadge}</span> : null}
                              </span>
                            </Link>
                            {isFav || favoritesEditMode ? (
                              <button type="button" onClick={() => toggleFavorite(item.href)}
                                title={isFav ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti"}
                                className={`absolute right-1.5 top-1/2 -translate-y-1/2 z-10 text-xs transition-all ${isFav ? "text-amber-400 hover:text-rose-500 opacity-100" : "text-slate-300 hover:text-amber-400 opacity-0 group-hover/fav:opacity-100"}`}
                              >{isFav ? "★" : "☆"}</button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Operativo — gruppo collassabile */}
            {(authRole === "admin" || authRole === "supervisor" || authRole === "operator") && (() => {
              const groupActive = OPERATIVO_GROUP.items.some((i) => matchesPath(pathname, i.href));
              const isExpanded = groupActive || operativoOpen;
              const groupBadge = pendingQrReportsCount > 0 ? pendingQrReportsCount : 0;
              return (
                <div className="mt-0.5">
                  <button
                    type="button"
                    title={collapsed ? OPERATIVO_GROUP.label : undefined}
                    onClick={() => { if (!collapsed) setOperativoOpen((v) => !v); }}
                    className={`group relative flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                      groupActive
                        ? "bg-slate-900 text-white"
                        : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                    } ${collapsed ? "justify-center" : ""}`}
                  >
                    {groupActive ? <span className="absolute bottom-1.5 left-0 top-1.5 w-1 rounded-r-full bg-amber-500" /> : null}
                    <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition ${groupActive ? "bg-white/20 text-white shadow-[0_2px_8px_rgba(99,102,241,0.30)]" : "bg-white/10 text-slate-300"}`}>
                      {renderNavIcon("O")}
                    </span>
                    {!collapsed ? (
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-1">
                        <span className="truncate text-sm font-medium">{OPERATIVO_GROUP.label}</span>
                        <span className="flex items-center gap-1.5">
                          {groupBadge > 0 && !isExpanded ? (
                            <span className="inline-flex items-center rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                              {groupBadge > 99 ? "99+" : groupBadge}
                            </span>
                          ) : null}
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-3 w-3 shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`} aria-hidden="true">
                            <path d="M6 3.5l4 4.5-4 4.5" />
                          </svg>
                        </span>
                      </span>
                    ) : groupBadge > 0 ? (
                      <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-600 text-[9px] font-semibold text-white">
                        {groupBadge > 9 ? "9+" : groupBadge}
                      </span>
                    ) : null}
                  </button>
                  {!collapsed && isExpanded && (
                    <div className="ml-4 mt-1 space-y-0.5 border-l-2 border-indigo-400/30 pl-2">
                      {OPERATIVO_GROUP.items.map((item) => {
                        const active = matchesPath(pathname, item.href);
                        const isFav = favorites.includes(item.href);
                        const itemBadge = item.href === "/inbox/fleet-reports" && pendingQrReportsCount > 0 ? pendingQrReportsCount : 0;
                        return (
                          <div key={item.href} className="group/fav relative">
                            <Link href={item.href}
                              className={`flex min-w-0 items-center gap-2.5 rounded-xl border px-2 py-1.5 text-sm transition ${
                                active ? "bg-indigo-600 text-white font-semibold" : "border-transparent text-slate-200 hover:bg-white/10 hover:text-white"
                              } ${isFav || favoritesEditMode ? "pr-7" : ""}`}
                            >
                              <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center transition ${active ? "text-white" : "text-slate-400"}`}>
                                {renderNavIcon(item.icon)}
                              </span>
                              <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                                <span className="truncate">{item.label}</span>
                                {itemBadge > 0 ? <span className="inline-flex items-center rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">{itemBadge}</span> : null}
                              </span>
                            </Link>
                            {isFav || favoritesEditMode ? (
                              <button type="button" onClick={() => toggleFavorite(item.href)}
                                title={isFav ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti"}
                                className={`absolute right-1.5 top-1/2 -translate-y-1/2 z-10 text-xs transition-all ${isFav ? "text-amber-400 hover:text-rose-500 opacity-100" : "text-slate-300 hover:text-amber-400 opacity-0 group-hover/fav:opacity-100"}`}
                              >{isFav ? "★" : "☆"}</button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Mario Boss — gruppo collassabile */}
            {(authRole === "admin" || authRole === "supervisor") && (() => {
              const groupActive = MARIO_BOSS_GROUP.items.some((i) => matchesPath(pathname, i.href));
              return (
                <div className="mt-0.5">
                  <button
                    type="button"
                    title={collapsed ? MARIO_BOSS_GROUP.label : undefined}
                    onClick={() => { if (!collapsed) setMarioBossOpen((v) => !v); }}
                    className={`group relative flex w-full min-w-0 items-center gap-3 rounded-xl border px-2.5 py-2 text-left transition ${
                      groupActive
                        ? "border-indigo-400/40 bg-gradient-to-r from-indigo-600/85 to-violet-600/75 text-white shadow-[0_8px_20px_rgba(79,70,229,0.20)]"
                        : "border-transparent text-slate-200 hover:bg-white/10 hover:text-white"
                    } ${collapsed ? "justify-center" : ""}`}
                  >
                    {groupActive ? <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r-full bg-red-500" /> : null}
                    <span className={`inline-flex shrink-0 items-center justify-center rounded-2xl transition-all duration-300 ${groupActive ? "bg-white/20 text-white shadow-sm" : "bg-white/10 text-indigo-300 ring-1 ring-white/10"} ${marioBossOpen ? "h-10 w-10" : "h-8 w-8"}`}>
                      <span className={`transition-all duration-300 ${marioBossOpen ? "text-2xl" : "text-base"}`} aria-hidden="true">🎮</span>
                    </span>
                    {!collapsed ? (
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-1">
                        <span className="truncate text-sm font-semibold">{MARIO_BOSS_GROUP.label}</span>
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-3 w-3 shrink-0 transition-transform ${marioBossOpen ? "rotate-90" : ""}`} aria-hidden="true">
                          <path d="M6 3.5l4 4.5-4 4.5" />
                        </svg>
                      </span>
                    ) : null}
                  </button>
                  {!collapsed && marioBossOpen && (
                    <div className="ml-4 mt-1 space-y-0.5 border-l-2 border-indigo-400/30 pl-2">
                      {MARIO_BOSS_GROUP.items.map((item) => {
                        const active = matchesPath(pathname, item.href);
                        const isFav = favorites.includes(item.href);
                        return (
                          <div key={item.href} className="group/fav relative">
                            <Link href={item.href}
                              className={`flex min-w-0 items-center gap-2.5 rounded-xl border px-2 py-1.5 text-sm transition ${
                                active ? "bg-indigo-600 text-white font-semibold" : "border-transparent text-slate-200 hover:bg-white/10 hover:text-white"
                              } ${isFav || favoritesEditMode ? "pr-7" : ""}`}
                            >
                              <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center transition ${active ? "text-white" : "text-slate-400"}`}>
                                {renderNavIcon(item.icon)}
                              </span>
                              <span className="truncate">{item.label}</span>
                            </Link>
                            {isFav || favoritesEditMode ? (
                              <button type="button" onClick={() => toggleFavorite(item.href)}
                                title={isFav ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti"}
                                className={`absolute right-1.5 top-1/2 -translate-y-1/2 z-10 text-xs transition-all ${isFav ? "text-amber-400 hover:text-rose-500 opacity-100" : "text-slate-300 hover:text-amber-400 opacity-0 group-hover/fav:opacity-100"}`}
                              >{isFav ? "★" : "☆"}</button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Karmen Peach — gruppo collassabile */}
            {(authRole === "admin" || authRole === "supervisor") && (() => {
              const groupActive = KARMEN_PEACH_GROUP.items.some((i) => matchesPath(pathname, i.href));
              return (
                <div className="mt-0.5">
                  <button
                    type="button"
                    title={collapsed ? KARMEN_PEACH_GROUP.label : undefined}
                    onClick={() => { if (!collapsed) setKarmenPeachOpen((v) => !v); }}
                    className={`group relative flex w-full min-w-0 items-center gap-3 rounded-xl border px-2.5 py-2 text-left transition ${
                      groupActive
                        ? "border-indigo-400/40 bg-gradient-to-r from-indigo-600/85 to-violet-600/75 text-white shadow-[0_8px_20px_rgba(79,70,229,0.20)]"
                        : "border-transparent text-slate-200 hover:bg-white/10 hover:text-white"
                    } ${collapsed ? "justify-center" : ""}`}
                  >
                    {groupActive ? <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r-full bg-pink-500" /> : null}
                    <span className={`inline-flex shrink-0 items-center justify-center rounded-2xl transition-all duration-300 ${groupActive ? "bg-white/20 text-white shadow-sm" : "bg-white/10 text-violet-300 ring-1 ring-white/10"} ${karmenPeachOpen ? "h-10 w-10" : "h-8 w-8"}`}>
                      <span className={`transition-all duration-300 ${karmenPeachOpen ? "text-2xl" : "text-base"}`} aria-hidden="true">🌸</span>
                    </span>
                    {!collapsed ? (
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-1">
                        <span className="truncate text-sm font-semibold">{KARMEN_PEACH_GROUP.label}</span>
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-3 w-3 shrink-0 transition-transform ${karmenPeachOpen ? "rotate-90" : ""}`} aria-hidden="true">
                          <path d="M6 3.5l4 4.5-4 4.5" />
                        </svg>
                      </span>
                    ) : null}
                  </button>
                  {!collapsed && karmenPeachOpen && (
                    <div className="ml-4 mt-1 space-y-0.5 border-l-2 border-violet-400/30 pl-2">
                      {KARMEN_PEACH_GROUP.items.map((item) => {
                        const active = matchesPath(pathname, item.href);
                        const isFav = favorites.includes(item.href);
                        return (
                          <div key={item.href} className="group/fav relative">
                            <Link href={item.href}
                              className={`flex min-w-0 items-center gap-2.5 rounded-xl border px-2 py-1.5 text-sm transition ${
                                active ? "bg-violet-600 text-white font-semibold" : "border-transparent text-slate-200 hover:bg-white/10 hover:text-white"
                              } ${isFav || favoritesEditMode ? "pr-7" : ""}`}
                            >
                              <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center transition ${active ? "text-white" : "text-slate-400"}`}>
                                {renderNavIcon(item.icon)}
                              </span>
                              <span className="truncate">{item.label}</span>
                            </Link>
                            {isFav || favoritesEditMode ? (
                              <button type="button" onClick={() => toggleFavorite(item.href)}
                                title={isFav ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti"}
                                className={`absolute right-1.5 top-1/2 -translate-y-1/2 z-10 text-xs transition-all ${isFav ? "text-amber-400 hover:text-rose-500 opacity-100" : "text-slate-300 hover:text-amber-400 opacity-0 group-hover/fav:opacity-100"}`}
                              >{isFav ? "★" : "☆"}</button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Impostazioni */}
            {settingsGroups.length > 0 ? (
              <div className="mt-4 border-t border-white/15 pt-3">
                {!collapsed ? (
                  <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Impostazioni</p>
                ) : null}
                <button
                  type="button"
                  title={collapsed ? "Impostazioni" : undefined}
                  onClick={() => setSettingsOpen((prev) => !prev)}
                  className={`group relative flex w-full min-w-0 items-center gap-3 rounded-xl border px-2.5 py-2.5 text-left transition ${
                    isSettingsExpanded
                      ? "border-indigo-400/40 bg-gradient-to-r from-indigo-600/80 to-violet-600/70 text-white shadow-[0_6px_18px_rgba(79,70,229,0.22)]"
                      : "border-transparent text-slate-200 hover:bg-white/10 hover:text-white"
                  } ${collapsed ? "justify-center" : ""}`}
                >
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center transition">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3.5 w-3.5" aria-hidden="true">
                      <circle cx="8" cy="8" r="2" />
                      <path d="M8 2.5v1.5M8 12v1.5M2.5 8H4M12 8h1.5M4.2 4.2l1 1M10.8 10.8l1 1M11.8 4.2l-1 1M5.2 10.8l-1 1" />
                    </svg>
                  </span>
                  {!collapsed ? (
                    <>
                      <span className="flex-1 truncate text-sm font-medium">Impostazioni</span>
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform duration-200 ${isSettingsExpanded ? "rotate-180" : ""}`} aria-hidden="true">
                        <path d="M3.5 6l4.5 4 4.5-4" />
                      </svg>
                    </>
                  ) : null}
                </button>

                {isSettingsExpanded && !collapsed ? (
                  <div className="mt-2 space-y-2 px-1">
                    {settingsGroups.map((group) => (
                      <div key={group.title} className="space-y-0.5 rounded-2xl border border-white/10 bg-white/[0.055] p-2">
                        <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">{group.title}</p>
                        {group.items.map((item) => {
                          const active = matchesPath(pathname, item.href);
                          const isFav = favorites.includes(item.href);
                          return (
                            <div key={item.href} className="group/fav relative">
                              <Link
                                href={item.href}
                                className={`flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm transition ${
                                  active ? "bg-indigo-600 text-white shadow-sm" : "text-slate-200 hover:bg-white/10 hover:text-white"
                                } ${isFav || favoritesEditMode ? "pr-8" : ""}`}
                              >
                                <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition ${iconWrapClass(active)}`}>
                                  {renderNavIcon(item.icon)}
                                </span>
                                <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                                  <span className="truncate">{item.label}</span>
                                  {item.href === "/settings/users" && pendingAccessRequestCount > 0 ? (
                                    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                                      {pendingAccessRequestCount > 99 ? "99+" : pendingAccessRequestCount}
                                    </span>
                                  ) : null}
                                  {item.href === "/inbox/agency-reviews" && pendingAgencyReviewCount > 0 ? (
                                    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                                      {pendingAgencyReviewCount > 99 ? "99+" : pendingAgencyReviewCount}
                                    </span>
                                  ) : null}
                                  {(item.href === "/fleet-ops" || item.href === "/inbox/fleet-reports") && pendingQrReportsCount > 0 ? (
                                    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                                      {pendingQrReportsCount > 99 ? "99+" : pendingQrReportsCount}
                                    </span>
                                  ) : null}
                                </span>
                              </Link>
                              {isFav || favoritesEditMode ? (
                                <button type="button" onClick={() => toggleFavorite(item.href)}
                                  title={isFav ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti"}
                                  className={`absolute right-2 top-1/2 -translate-y-1/2 z-10 text-xs transition-all ${isFav ? "text-amber-400 hover:text-rose-400 opacity-100" : "text-slate-500 hover:text-amber-400 opacity-0 group-hover/fav:opacity-100"}`}
                                >{isFav ? "★" : "☆"}</button>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* ── Footer utente + pulsante preferiti ──────────────── */}
            <div className={`mt-3 border-t border-slate-100 pt-2 space-y-1 ${collapsed ? "flex flex-col items-center" : ""}`}>
              {/* User chip */}
              {authName || authEmail ? (
                <button
                  type="button"
                  onClick={handleSignOut}
                  title="Esci"
                  className={`group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition hover:bg-rose-50 ${collapsed ? "justify-center" : ""}`}
                >
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-bold text-white shadow-sm">
                    {(authName ?? authEmail ?? "U").trim().charAt(0).toUpperCase()}
                  </span>
                  {!collapsed && (
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-slate-700 group-hover:text-rose-700">
                        {authName ?? authEmail}
                      </span>
                      <span className="block text-[10px] text-slate-400 capitalize">{authRole}</span>
                    </span>
                  )}
                </button>
              ) : null}
              {/* Personalizza preferiti */}
              {!collapsed && authUserId ? (
                <button
                  type="button"
                  onClick={() => setFavoritesEditMode((v) => !v)}
                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-xs transition ${
                    favoritesEditMode
                      ? "bg-amber-50 text-amber-700 font-semibold"
                      : "text-slate-400 hover:text-slate-600"
                  }`}
                >
                  <span>{favoritesEditMode ? "★" : "☆"}</span>
                  <span>{favoritesEditMode ? "Fine personalizzazione" : "Personalizza preferiti"}</span>
                </button>
              ) : null}
            </div>
          </nav>
        </div>
      </aside>

      <div className="min-w-0 space-y-4">
        {pathname !== "/services" && pathname !== "/services/new" && pathname !== "/inbox" && pathname !== "/dashboard" && pathname !== "/arrivals" && pathname !== "/departures" && pathname !== "/mappa-live" ? <header className="relative z-30 overflow-hidden rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm md:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Vista operativa</p>
            <h2 className="mt-0.5 line-clamp-1 text-xl font-extrabold tracking-tight text-slate-950 md:text-2xl">{title}</h2>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            {!isHomePage ? (
              <Link
                href={homeHref}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-blue-700 transition hover:bg-blue-100"
                title="Torna al cruscotto"
                aria-label="Torna al cruscotto"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0" aria-hidden="true">
                  <path d="m2.5 7.5 5.5-4.5 5.5 4.5M4 6.5v6h8v-6M6.5 12.5v-4h3v4" />
                </svg>
                <span>Cruscotto</span>
              </Link>
            ) : null}
            {authRole === "admin" || authRole === "supervisor" ? (
              <Link
                href="/settings/users"
                className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition ${
                  pendingAccessRequestCount > 0
                    ? "border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
                title={
                  pendingAccessRequestCount > 0
                    ? `${pendingAccessRequestCount} richieste accesso da approvare`
                    : "Nessuna nuova richiesta accesso"
                }
              >
                <span className="relative inline-flex">
                  <HeaderBellIcon />
                  {pendingAccessRequestCount > 0 ? (
                    <span className="absolute -right-2 -top-2 inline-flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 py-0.5 text-[10px] font-semibold text-white">
                      {pendingAccessRequestCount > 99 ? "99+" : pendingAccessRequestCount}
                    </span>
                  ) : null}
                </span>
                <span className="hidden sm:inline">Richieste agenzia</span>
              </Link>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={toggleTheme}
                className="inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                title={isDark ? "Passa alla modalità chiara" : "Passa alla modalità scura"}
              >
                <span className="inline-flex items-center gap-2">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0" aria-hidden="true">
                    {isDark
                      ? <path d="M8 3.5a4.5 4.5 0 1 0 4.5 4.5A3.5 3.5 0 0 1 8 3.5Z" />
                      : <><circle cx="8" cy="8" r="2.5" /><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.8 3.8l1 1M11.2 11.2l1 1M11.2 3.8l-1 1M4.8 11.2l-1 1" /></>}
                  </svg>
                  <span className="hidden lg:inline">{isDark ? "Modalità chiara" : "Modalità scura"}</span>
                  <span className="lg:hidden">Tema</span>
                </span>
              </button>
              {authRole !== "agency" && (
              <button
                type="button"
                onClick={toggleInboxSound}
                className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition ${
                  inboxSoundEnabled
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
                title={`Suono inbox ${inboxSoundEnabled ? "attivo" : "disattivo"}`}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0" aria-hidden="true">
                  <path d="M3.5 6h2l3-3v10l-3-3h-2zM10.5 6.5a2.5 2.5 0 0 1 0 3" />
                </svg>
                <span className="hidden lg:inline">Suono inbox {inboxSoundEnabled ? "ON" : "OFF"}</span>
                <span className="lg:hidden">Inbox {inboxSoundEnabled ? "ON" : "OFF"}</span>
              </button>
              )}
              <button
                type="button"
                onClick={handleSignOut}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 text-xs font-semibold text-rose-600 transition hover:bg-rose-100"
                title="Esci"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0" aria-hidden="true">
                  <path d="M10.5 5.5 13 8l-2.5 2.5M13 8H6M7 3.5H3.5v9H7" />
                </svg>
                <span>Esci</span>
              </button>
              {authRole === "admin" && (authName?.toLowerCase().includes("leonardo") || authEmail?.toLowerCase().includes("leonardo")) ? (
                <Image
                  src="/bowser-avatar.png"
                  alt="Leonardo"
                  width={56} height={56}
                  className="h-14 w-14 rounded-xl border border-slate-100 bg-slate-50 object-contain p-1 shadow-sm"
                />
              ) : authRole === "admin" && authName?.toLowerCase().includes("mario") ? (
                <Image
                  src="/mario-avatar.png"
                  alt="Mario"
                  width={56} height={56}
                  className="h-14 w-14 rounded-xl border border-slate-100 bg-slate-50 object-contain p-1 shadow-sm"
                />
              ) : authRole === "admin" && (authName?.toLowerCase().includes("karmen") || authName?.toLowerCase().includes("peach")) ? (
                <Image
                  src="/karmen-avatar.png"
                  alt="Karmen"
                  width={56} height={56}
                  className="h-14 w-14 rounded-xl border border-slate-100 bg-slate-50 object-contain p-1 shadow-sm"
                />
              ) : authRole === "operator" && authGender === "female" ? (
                <Image
                  src="/toadette-avatar.png"
                  alt="Operatrice"
                  width={56} height={56}
                  className="h-14 w-14 rounded-xl border border-slate-100 bg-slate-50 object-contain p-1 shadow-sm"
                />
              ) : authRole === "operator" && authGender === "male" ? (
                <Image
                  src="/bowser-avatar.png"
                  alt="Operatore"
                  width={56} height={56}
                  className="h-14 w-14 rounded-xl border border-slate-100 bg-slate-50 object-contain p-1 shadow-sm"
                />
              ) : authRole === "supervisor" ? (
                <Image
                  src="/luca-avatar.png"
                  alt="Luca"
                  width={56} height={56}
                  className="h-14 w-14 rounded-xl border border-slate-100 bg-slate-50 object-cover p-1 shadow-sm"
                />
              ) : (
                <div className="inline-flex h-9 min-w-9 items-center justify-center rounded-lg border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 shadow-sm">
                  {(authRole ?? "U").slice(0, 2).toUpperCase()}
                </div>
              )}
            </div>
          </div>
          </div>
          <div className="mt-3 mobile-nav-strip">
            {mainNav.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={`mobile-${item.href}`}
                  href={item.href}
                  className={active ? "btn-primary px-3 py-1.5 text-xs" : "btn-secondary px-3 py-1.5 text-xs"}
                >
                  {item.label}
                  {item.href === "/inbox" && inboxPendingCount > 0 ? ` (${inboxPendingCount > 99 ? "99+" : inboxPendingCount})` : ""}
                  {item.href === "/whatsapp" && whatsAppUnreadCount > 0 ? ` (${whatsAppUnreadCount > 99 ? "99+" : whatsAppUnreadCount})` : ""}
                  {item.href === "/agency-requests" && pendingAgencyBookingsCount > 0 ? ` (${pendingAgencyBookingsCount > 99 ? "99+" : pendingAgencyBookingsCount})` : ""}
                </Link>
              );
            })}
            {settingsGroups.length > 0 ? (
              <button
                type="button"
                onClick={() => setSettingsOpen((prev) => !prev)}
                className={isSettingsExpanded ? "btn-primary px-3 py-1.5 text-xs" : "btn-secondary px-3 py-1.5 text-xs"}
              >
                Impostazioni
              </button>
            ) : null}
          </div>
          {isSettingsExpanded && settingsGroups.length > 0 ? (
            <div className="mt-3 space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 md:hidden">
              {settingsGroups.map((group) => (
                <div key={`mobile-${group.title}`} className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">{group.title}</p>
                  <div className="mobile-nav-strip">
                    {group.items.map((item) => {
                      const active = matchesPath(pathname, item.href);
                      return (
                        <Link
                          key={`mobile-settings-${item.href}`}
                          href={item.href}
                          className={active ? "btn-primary px-3 py-1.5 text-xs" : "btn-secondary px-3 py-1.5 text-xs"}
                        >
                          {item.label}
                          {item.href === "/settings/users" && pendingAccessRequestCount > 0 ? ` (${pendingAccessRequestCount > 99 ? "99+" : pendingAccessRequestCount})` : ""}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </header> : null}
        {children}
      </div>
      {slaAlertMessage ? (
        <div className="fixed left-0 right-0 top-0 z-[100] flex items-center justify-between gap-3 bg-red-600 px-4 py-3 shadow-lg">
          <div className="flex items-center gap-3">
            <span className="text-xl" aria-hidden="true">🚨</span>
            <div>
              <p className="text-sm font-bold text-white">Servizio senza autista</p>
              <p className="text-xs text-red-100">{slaAlertMessage}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href="/dispatch"
              onClick={() => setSlaAlertMessage(null)}
              className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50"
            >
              Vai al dispatch
            </Link>
            <button
              type="button"
              onClick={() => setSlaAlertMessage(null)}
              className="text-lg font-bold text-red-100 hover:text-white"
              aria-label="Chiudi"
            >
              ×
            </button>
          </div>
        </div>
      ) : null}
      {liveToastMessage ? (
        <div className="fixed bottom-4 right-4 z-[70] rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {liveToastMessage}
        </div>
      ) : null}
      {authRole && authRole !== "agency" ? <MotivationalModal storageIdentity={authEmail ?? authTenantId ?? authRole} userName={authName} /> : null}
      </section>
    </>
  );
}

