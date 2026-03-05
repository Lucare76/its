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
          padding: "56px",
          background: "linear-gradient(135deg, #0f172a 0%, #1e3a8a 55%, #0ea5e9 100%)",
          color: "white",
          fontFamily: "Arial, sans-serif"
        }}
      >
        <div style={{ display: "flex", fontSize: 28, letterSpacing: 2, opacity: 0.92 }}>ISCHIA TRANSFER</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", fontSize: 72, fontWeight: 800, lineHeight: 1.05 }}>Transfer Operations</div>
          <div style={{ display: "flex", fontSize: 34, opacity: 0.9 }}>Dispatch, Driver area e reminder WhatsApp</div>
        </div>
        <div style={{ display: "flex", fontSize: 22, opacity: 0.8 }}>ischia-transfer-beta</div>
      </div>
    ),
    size
  );
}

