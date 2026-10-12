.PHONY: build test dev
build:
	pnpm --dir web install --frozen-lockfile
	pnpm --dir web build
	go build -o ztail ./cmd/ztail
test: build
	go test -race ./...
	go vet ./...
	pnpm --dir web test:e2e
dev: build
	go run ./cmd/ztail
