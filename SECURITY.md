# Security policy

These packages run on merchants' storefronts and servers, so we treat any way they could weaken a merchant's site as a serious issue.

## Reporting a vulnerability

Please report privately through GitHub: the **Security** tab of this repository, then **Report a vulnerability**. Do not open a public issue. We acknowledge reports within two business days and aim to ship a fix, as a new version, within seven days for anything that affects merchants' sites.

## Supply chain

- Published only from this repository's Release workflow through npm trusted publishing (OIDC); no npm token exists. Every version has a provenance attestation: `npm audit signatures` verifies it.
- The publish job runs in a protected environment that needs a maintainer's approval, installs no dependencies, and uploads the tarball the build job tested.
- GitHub Actions are pinned to full commit hashes; Dependabot proposes updates.
- The hosted tag is served as immutable releases pinned with Subresource Integrity hashes.
