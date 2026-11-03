import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  transpilePackages: ["@office/shared"],
  // the desktop bundle (apps/desktop/scripts/bundle.sh) runs the server from .next/standalone
  ...(process.env.OFFICE_DESKTOP_BUILD
    ? { output: "standalone", outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)) }
    : {}),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
