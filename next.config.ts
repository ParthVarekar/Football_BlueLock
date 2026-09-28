import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // fully client-side game → static export (served from a CDN, no server to cold-start)
  output: "export",
  images: { unoptimized: true },
  /* config options here */
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
};

export default nextConfig;
