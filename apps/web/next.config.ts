import type { NextConfig } from "next";

const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  transpilePackages: ["@editor/timeline", "@editor/composition"],
  devIndicators: false,
  experimental: { proxyTimeout: 300_000 },
  async rewrites() {
    const origin = process.env.API_ORIGIN ?? "http://127.0.0.1:4000";
    return [{ source: "/api/:path*", destination: origin + "/api/:path*" }];
  },
};

export default config;
