package web

import "embed"

// Assets is the production web build. Run pnpm --dir web build before Go builds.
//
//go:embed dist
var Assets embed.FS

// Messages supplies English fallbacks for structured API messages.
//
//go:embed src/locales/en.json
var Messages []byte
