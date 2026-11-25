import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: path.resolve(__dirname)
  },
  allowedDevOrigins: ["http://127.0.0.1:3010", "http://localhost:3010"],
  // sharp (con le librerie native libvips per glibc E musl, ~32 MB) veniva
  // copiato dentro 133 funzioni serverless pur non essendo usato dall'app:
  // su Vercel l'ottimizzazione immagini di next/image è un servizio separato.
  // Escluderlo riduce Functions Storage su ogni deploy.
  outputFileTracingExcludes: {
    "*": ["node_modules/sharp/**", "node_modules/@img/**", "node_modules/.pnpm/sharp@*/**", "node_modules/.pnpm/@img+*/**"],
  },
};

export default nextConfig;
