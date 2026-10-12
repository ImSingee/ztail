# Checklist
- Build web assets before Go build/test because they are embedded.
- The standalone binary has no fixture endpoints or mocked Tailnet.
- No-API local GetServices results are ACL-filtered; absent does not prove globally undefined.
- A status badge alone does not prove routing; assert backend response and listener withdrawal.
- Inspect every screenshot before citing it.
