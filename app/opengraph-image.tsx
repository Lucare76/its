import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = {
  width: 1200,
  height: 630
};
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px",
          background: "linear-gradient(135deg, #0f172a 0%, #1d4ed8 58%, #dbeafe 100%)",
          color: "white",
          fontFamily: "Segoe UI, sans-serif"
        }}
      >
        <div style={{ display: "flex", fontSize: 24, letterSpacing: 4, opacity: 0.92 }}>ISCHIA TRANSFER SERVICE</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", fontSize: 64, fontWeight: 700, lineHeight: 1.02 }}>Transfer affidabili dal 2006</div>
          <div style={{ display: "flex", fontSize: 30, opacity: 0.88 }}>Coordinamento diretto tra aeroporto, porto e hotel</div>
        </div>
        <div style={{ display: "flex", fontSize: 22, opacity: 0.8 }}>Esperienza per chi arriva a Ischia</div>
      </div>
    ),
    size
  );
}

