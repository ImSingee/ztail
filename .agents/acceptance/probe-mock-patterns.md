# Test-only control-plane fixtures
`TestBrowserServer` in `_test.go` substitutes only CatalogProvider, Tailnet and Registry interfaces. It uses real HTTP handlers, SQLite and reverse proxy. Fixture audit exposes controlled test requests and listener addresses; never session cookies or credentials. It does not establish trusted TLS, tailnet DNS or remote approval.
