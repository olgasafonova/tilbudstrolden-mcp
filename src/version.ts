// Server version, read from package.json at runtime.
//
// The compiled entry point is dist/server.js, so "../package.json" resolves to
// the repo root. That holds for a git checkout and for the Dockerfile in this
// repo, which copies package.json into the runtime stage on purpose. It does
// not hold for an image that copies only dist/, and a missing version string
// should never take the whole server down, so fall back instead of throwing.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function readVersion(): string {
  try {
    const { version } = require("../package.json") as { version: string };
    return version;
  } catch {
    return "0.0.0-unknown";
  }
}

export const SERVER_VERSION = readVersion();
