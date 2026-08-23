## Auth pattern (all protected API routes)

Every `app/api/ops/` route uses `authorizePricingRequest` (a convenience alias for `authorizeServiceRoleRequest`):

```ts
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;   // 401/403 already sent
  // auth.admin  → Supabase admin client (service role)
  // auth.user   → { id, email }
  // auth.membership → { tenant_id, role, suspended }
}
```

`auth.admin` must be used (not the anon client) for all DB access inside API routes — it bypasses RLS and the service role handles multi-tenancy manually via `tenant_id` filters.

## Existing quotes system

A `quotes` table and `/api/ops/quotes` route already exist for **bus/excursion quotes sent to agencies** (`app/(app)/preventivo-ops/`). This is separate from any client-facing transfer quote system.
