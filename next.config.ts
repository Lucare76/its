import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: path.resolve(__dirname)
  },
  allowedDevOrigins: ["http://127.0.0.1:3010"]
};

export default nextConfig;
