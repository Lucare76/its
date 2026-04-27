import { BusQrVerifyCard } from "@/components/bus-qr-verify-card";

export const runtime = "nodejs";

export default async function BusQrVerifyPage({
  params,
}: {
  params: Promise<{ bookingId: string; direction: "outbound" | "return"; token: string }>;
}) {
  const { bookingId, direction, token } = await params;
  return <BusQrVerifyCard bookingId={bookingId} direction={direction} token={token} />;
}
