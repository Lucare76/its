import { describe, it, expect, vi, beforeEach } from "vitest";
import { adminGetUserByEmail } from "@/lib/server/admin-user-lookup";

const MOCK_URL = "https://example.supabase.co";
const MOCK_KEY = "service-role-key";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", MOCK_URL);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", MOCK_KEY);
  vi.restoreAllMocks();
});

describe("adminGetUserByEmail", () => {
  it("returns the matching user when found", async () => {
    const mockUser = { id: "uuid-123", email: "luca@example.com", user_metadata: {} };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ users: [mockUser] }), { status: 200 })
    );

    const { user, error } = await adminGetUserByEmail("luca@example.com");

    expect(error).toBeNull();
    expect(user).not.toBeNull();
    expect(user?.id).toBe("uuid-123");
    expect(user?.email).toBe("luca@example.com");
  });

  it("returns null user when email not in list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ users: [{ id: "other", email: "other@example.com" }] }), { status: 200 })
    );

    const { user, error } = await adminGetUserByEmail("luca@example.com");
    expect(error).toBeNull();
    expect(user).toBeNull();
  });

  it("is case-insensitive for the email match", async () => {
    const mockUser = { id: "uuid-456", email: "Luca@Example.COM" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ users: [mockUser] }), { status: 200 })
    );

    const { user } = await adminGetUserByEmail("luca@example.com");
    expect(user?.id).toBe("uuid-456");
  });

  it("returns error string on non-200 HTTP response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 })
    );

    const { user, error } = await adminGetUserByEmail("luca@example.com");
    expect(user).toBeNull();
    expect(error).toContain("401");
  });

  it("returns config error when env vars are missing", async () => {
    vi.unstubAllEnvs();
    const { user, error } = await adminGetUserByEmail("luca@example.com");
    expect(user).toBeNull();
    expect(error).toBeTruthy();
  });

  it("calls the GoTrue admin endpoint with correct URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ users: [] }), { status: 200 })
    );

    await adminGetUserByEmail("test@example.com");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/auth/v1/admin/users");
    expect(calledUrl).toContain(encodeURIComponent("test@example.com"));
  });
});
