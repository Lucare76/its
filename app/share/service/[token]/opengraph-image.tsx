import { ImageResponse } from "next/og";
import { formatServiceDateTime, getSharedServiceByToken } from "@/lib/server/service-share";

export const runtime = "nodejs";
export const size = {
  width: 1200,
  height: 630
};
export const contentType = "image/png";

interface OGProps {
  params: Promise<{ token: string }>;
}

export default async function Image({ params }: OGProps) {
  const { token } = await params;
  const service = await getSharedServiceByToken(token);

  if (!service) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            background: "#0f172a",
            color: "white",
            fontFamily: "Arial, sans-serif",
            gap: 18
          }}
        >
          <div style={{ fontSize: 34, fontWeight: 700 }}>Ischia Transfer</div>
          <div style={{ fontSize: 48, fontWeight: 800 }}>Link non disponibile</div>
        </div>
      ),
      size
    );
  }

  const dateTime = formatServiceDateTime(service.date, service.time);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "56px",
          background: "linear-gradient(120deg, #0b1220 0%, #0f766e 100%)",
          color: "white",
          fontFamily: "Arial, sans-serif"
        }}
      >
        <div style={{ display: "flex", fontSize: 26, letterSpacing: 2, opacity: 0.95 }}>ISCHIA TRANSFER</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", fontSize: 60, fontWeight: 800 }}>Transfer Ischia</div>
          <div style={{ display: "flex", fontSize: 36 }}>{dateTime}</div>
          <div style={{ display: "flex", fontSize: 30, opacity: 0.95 }}>Hotel: {service.hotel_name ?? "Da confermare"}</div>
          <div style={{ display: "flex", fontSize: 28, opacity: 0.88 }}>Porto/Nave: {service.vessel ?? "Da confermare"}</div>
        </div>
        <div style={{ display: "flex", fontSize: 22, opacity: 0.82 }}>Condiviso da Ischia Transfer</div>
      </div>
    ),
    size
  );
}

