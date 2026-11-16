## Why

Without MDM, every device is installed with the Downloader and updates itself (D40, Plan-v3.5 §5.7).
WorkBeat staff must publish each package per platform and architecture and set the global minimum
version (Plan-v3.5 §4.6); IT must download the Downloader and the packages through signed,
short-lived links (Plan-v3.5 §4.4 "Deployment", W31); and each device's policy must point at the
newest package for its platform and architecture so an outdated agent can update (D40).

## What Changes

- **Staff publish and withdraw releases** (`POST /v1/staff/agent-releases`,
  `POST /v1/staff/agent-releases/:id/withdraw`, `GET /v1/staff/agent-releases`): product, platform, arch,
  version, `min_supported`, storage path, SHA-256, signature, size and notes. macOS ships one
  universal `.pkg`; Windows one MSI per architecture (W31).
- **The effective minimum version** is the greater of the global minimum (the newest live agent
  release's `min_supported` per platform) and the company's `min_agent_version`, which the admin or
  IT sets with `PUT /v1/deployment/min-agent-version`.
- **`GET /v1/downloads`** gives the admin and IT short-lived signed links to the Downloader and the
  latest agent package per platform and architecture.
- **Policy update fields**: `update_package_url` and `update_package_sha256` point at the newest live
  release for the device's OS and architecture, inside `GET /v1/agents/policy` (serve-agent-policy).

## Capabilities

### New Capabilities

- `agent-releases`: publishing, withdrawing and listing releases; the global and effective minimum.
- `installer-downloads`: signed download links for IT.
- `agent-updates`: how the policy's update fields are chosen and signed; the company minimum.

### Modified Capabilities

None.

## Impact

- Consumed by both agents: `package-and-deploy-macos` and `package-and-deploy-windows`
  (`agent-updates`, `installer-package`) and `report-device-health/policy-refresh`
  (`min_agent_version`, `outdated`).
- Depends on `serve-agent-policy` (`agent-policy` owns the route, ETag and `policy_version`) and
  `enroll-devices`. `receive-device-health` (`device-status`) flags `outdated` against the effective
  minimum defined here.
- Schema: `agent_releases`, `companies.min_agent_version`, `companies.policy_version`. Storage:
  private bucket `agents`. No migration; see `design.md` for the `signature` column.
