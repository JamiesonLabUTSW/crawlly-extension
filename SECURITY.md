# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately.

Include:

- affected version (manifest version)
- reproduction steps
- impact assessment
- proof-of-concept details (if available)

Do not open public issues for undisclosed vulnerabilities.

## Scope

In scope:

- extension runtime code (`background.js`, `popup.js`, `popup.html`, `popup.css`)
- permission model (`manifest.json`)
- packaging and CI scripts

Out of scope:

- vulnerabilities in upstream browser engines
- vulnerabilities in ETHOS itself

## Security controls in this repo

- Minimal permission model in `manifest.json`
- Host-restricted access to `https://ethos.swmed.edu/*`
- CI security check script (`scripts/security-check.mjs`)
- Manifest policy check script (`scripts/validate-manifest.mjs`)
- Review-required files via `CODEOWNERS`

## Disclosure timeline (target)

- Acknowledge report: within 3 business days
- Triage decision: within 10 business days
- Fix/release target: risk-based

## Safe harbor

Good-faith security research and private disclosure are supported.
