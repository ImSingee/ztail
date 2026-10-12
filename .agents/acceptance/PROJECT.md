# ztail acceptance adapter

Go application in `internal/ztail`, production entry `cmd/ztail`, embedded Vite application in `web`.

## Environment
- Install/build: `pnpm --dir web install --frozen-lockfile && pnpm --dir web build && go build -o ztail ./cmd/ztail`.
- Production start: `./ztail`; required `ADMIN_PASSWORD`, `ZEABUR_API_KEY`, `ZEABUR_SERVER_ID`; `PORT` defaults 8080, `DATA_DIR` defaults /data.
- Browser fixture: `ZTAIL_E2E=1 go test ./internal/ztail -run '^TestBrowserServer$' -count=1 -timeout=10m`. Actual App/SQLite/proxy, fixture Zeabur/Tailnet only. HTTP ports 18080 and optional-API 18090, upstream 18082.
- Health: `/healthz`; inspect `version` build marker before evidence. Test fixture is compiled only in `_test.go`, never in shipped binary.
- Stop only the process started by this round with SIGINT; fixture cleans its servers and temporary data.

## Auth and surfaces
- Fixture admin password: fixture-password (test data, never production).
- GET `/api/session` returns `authenticated`; session cookie is HttpOnly and mutation requires X-CSRF-Token.
- Web flows: `/` service catalogue, `/services` published services, `/services/new`, `/services/<id>`, `/settings`.
- Playwright: `pnpm --dir web test:e2e`; screenshot/audit evidence defaults to `web/test-results/evidence`. Set `ZTAIL_EVIDENCE_DIR=../.acceptances/standalone-ztail/round-N/assets` for an acceptance round; never overwrite a published round.
- Real Zeabur/tailnet checks require user-owned credentials and interactive authorization; never infer success from fixture state.

## Constraints
Only one deployment owns a state volume. Zeabur refresh never publishes automatically. Do not expose a production fixture mode. Docker runs as UID 10001; data mount must be writable by it.
