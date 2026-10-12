package web

import "embed"

// Assets is the production web build. Run pnpm --dir web build before Go builds.
//
//go:embed dist
var Assets embed.FS
