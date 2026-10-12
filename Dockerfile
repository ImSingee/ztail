FROM --platform=$BUILDPLATFORM node:24-alpine AS frontend
WORKDIR /src/web
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM --platform=$BUILDPLATFORM golang:1.27.1-alpine AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /src/web/dist ./web/dist
ARG VERSION=dev
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /ztail ./cmd/ztail

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && addgroup -g 10001 ztail && adduser -D -u 10001 -G ztail ztail && mkdir /data && chown ztail:ztail /data
COPY --from=backend /ztail /usr/local/bin/ztail
USER 10001:10001
ENV DATA_DIR=/data PORT=8080 TAILSCALE_TAG=ztail CLUSTER_DOMAIN=cluster.local
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/ztail"]
