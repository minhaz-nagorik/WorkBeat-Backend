# Open questions

| # | Question | Who answers | Blocks |
|---|---|---|---|
| Q1 | The agent wire contract. **Drafted here** in [agent-contract.md](../core/api/agent-contract.md) (B9); needs sign-off from both agent owners and publishing as `packages/shared` | Backend + agent owners | Agent change 2 onward |
| Q2 | The employee monitoring notice text (default `notice_text`) | Counsel and product | Pilot |
| Q5 | Seat behaviour when two people share one device. Today one binding holds one seat and belongs to one employee (D48) | Product | — |
| Q6 | API host names a release build accepts | Backend owner | Release builds |
| Q10 | Format of the device ID the agent produces (`hardware_id`). A new device ID after a reinstall is a new binding and takes a second seat until the old binding is released (D2, D48) | Agent owners | Agent change 2 |
| Q11 | Which region hosts EU customers | Product | — |
| Q12 | Starter / Growth minimum charges for very small companies | Product | Stripe setup |
| Q13 | Plan §6.2 still lists `policy_versions`; B5 replaced it. Edit the plan | Product (plan owner) | — |
| Q14 | How an expired company subscribes again, and what its devices see on the way back | Product | — |
| Q15 | TLS certificates for custom domains: which proxy terminates them (the PRD's Google load balancer is gone with Vercel/Cloud Run) | Backend owner | Custom domains |
| Q16 | The agent repositories are behind D43–D48 (portal tokens, `--token`, optional employee, unassigned queue, release upload window, `409 DEVICE_ASSIGNED`). Their Downloader and enrollment specs need updating | Agent owners | Agent change 2 |
| Q17 | Node 20 left upstream support in April 2026. Move the API to Node 22 LTS? (Plan §3 still says Node 20) | Backend owner | Change 1 |
| Q18 | API host: Cloud Run (docs default), Fly or Render | Backend owner | Deployment |
| Q19 | Rotating the uninstall token (no route) and the secrets encryption key (no key-version column) | Backend owner | Before pilot |
| Q20 | Trial end and first-invoice failure; plan downgrade below seats used; deleting a whole company on request; an expired company's data | Product | Change 3 |
| Q21 | Stripe price IDs differ between test and live mode: environment variables (docs) or `packages/shared` maps (provision-companies task 1.2) | Backend owner | Change 3 |
