import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `pdf-parse` (used for resume PDF text extraction, see
  // lib/storage/resumeFiles.ts) wraps pdfjs-dist plus the native
  // `@napi-rs/canvas` addon. Left to Next.js's default bundling/tracing,
  // the native platform binary for `@napi-rs/canvas` gets missed on
  // Vercel's serverless runtime, which breaks the `DOMMatrix` polyfill
  // pdf-parse needs at import time. Marking both as external packages
  // makes Next.js resolve them via plain `require()`/`import()` from
  // node_modules at runtime instead of bundling them, which is the
  // documented fix:
  // https://github.com/mehmet-kozan/pdf-parse/blob/main/docs/troubleshooting.md
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas"],
};

export default nextConfig;
