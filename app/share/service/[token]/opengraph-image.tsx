import { ImageResponse } from "next/og";
import QRCode from "qrcode";
import { getConfiguredAppUrl } from "@/lib/app-url";
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

/* eslint-disable @next/next/no-img-element */

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
  const appUrl = getConfiguredAppUrl() ?? "http://127.0.0.1:3010";
  const qrValue = `${appUrl}/scan/${service.id}`;
  const qrDataUrl = await QRCode.toDataURL(qrValue, {
    width: 220,
    margin: 1,
    color: { dark: "#0b1220", light: "#ffffff" }
  });

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          justifyContent: "space-between",
          padding: "56px",
          background: "linear-gradient(120deg, #0b1220 0%, #0f766e 100%)",
          color: "white",
          fontFamily: "Arial, sans-serif"
        }}
      >
        <div style={{ display: "flex", width: "68%", flexDirection: "column", justifyContent: "space-between" }}>
          <div style={{ display: "flex", fontSize: 26, letterSpacing: 2, opacity: 0.95 }}>ISCHIA TRANSFER</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", fontSize: 60, fontWeight: 800 }}>Transfer Ischia</div>
            <div style={{ display: "flex", fontSize: 36 }}>{dateTime}</div>
            <div style={{ display: "flex", fontSize: 30, opacity: 0.95 }}>Hotel: {service.hotel_name ?? "Da confermare"}</div>
            <div style={{ display: "flex", fontSize: 28, opacity: 0.88 }}>Porto/Nave: {service.vessel ?? "Da confermare"}</div>
            <div style={{ display: "flex", fontSize: 24, opacity: 0.8 }}>
              Meeting point: {service.meeting_point ?? "Da confermare"}
            </div>
          </div>
          <div style={{ display: "flex", fontSize: 22, opacity: 0.82 }}>Condiviso da Ischia Transfer</div>
        </div>
        <div
          style={{
            width: 260,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            borderRadius: 28,
            background: "rgba(255,255,255,0.14)",
            padding: "20px 18px"
          }}
        >
          <div style={{ display: "flex", fontSize: 22, fontWeight: 700 }}>QR Check-in</div>
          <img
            src={qrDataUrl}
            alt="QR code del servizio"
            width={220}
            height={220}
            style={{ display: "flex", borderRadius: 18, background: "#ffffff", padding: 10 }}
          />
          <div style={{ display: "flex", fontSize: 18, textAlign: "center", opacity: 0.88 }}>
            Mostra questo codice al driver
          </div>
        </div>
      </div>
    ),
    size
  );
}
