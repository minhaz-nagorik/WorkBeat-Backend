## Decisions

### Installers are served from a private bucket through signed links

**Amends:** PRD "Data model" (Storage: the `agents` bucket "is publicly readable").
**Why:** Plan-v3.5 §4.4 "Installer distribution" requires signed, short-lived download links. The
plan outranks the PRD.

### Windows releases carry no code signature

**Amends:** Plan-v3.5 §5.2 ("EV-signed" MSIs) as applied by W35 ("No MSI … Authenticode-signed").
**Why:** W35 is the newer Windows ruling, and the agent identifies a package by SHA-256. `0002_spec_gaps.sql` made
`agent_releases.signature` nullable, so a Windows release stores no signature and is identified
by `sha256`.

### The update URL lives at least 24 hours and the policy ETag tracks it

**Amends:** nothing upstream; it constrains `agent-policy` (serve-agent-policy).
**Why:** a policy is cached behind an ETag, so a 10-minute URL would be stale by the next `304`.
A URL signed once per UTC day and valid to the end of the next day keeps the body, and so its
body-hash ETag, stable within a day and changes it daily, so no cached policy holds a dead URL.
