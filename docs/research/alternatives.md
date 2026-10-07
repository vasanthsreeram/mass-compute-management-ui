# Research: alternatives for team management and spend tracking on Massed Compute

Checked 2026-10-07. Sources: Massed docs, the Massed-Compute GitHub org, public web and GitHub search for Massed Compute team, billing, spend, and dashboard apps.

## Result

No third-party app does team management and spend tracking for a Massed Compute account. What exists is Massed's own dashboard, an MCP connection for AI assistants, and public price-comparison sites. None of those attribute cost across a team or keep a usage history.

This repo is filling that gap.

## Massed's own Team page

Settings → Team at https://vm.massedcompute.com/settings/team shares one account's compute with other people. Docs: https://vm-docs.massedcompute.com/docs/settings/team

| Role | What they can do |
|------|------------------|
| Owner | Full control, including billing, invites, groups, and transferring ownership |
| Admin | Instance groups, invites, and member permissions |
| Member | Sees and manages instances in the groups they can access. Never sees billing |

- Invites go out by email. Pending invites stay on the same page until accepted, resent, or revoked.
- Every instance belongs to an instance group. A group controls who on the team can see and manage those VMs.
- One group is the default. New launches land there unless Deploy picks another. The Deploy page shows an instance-group picker only when more than one group is available.
- Visibility can be the whole team, admins only, or a custom list.
- Billing stays with the owner. Members never see billing.
- Owner-only actions: rename the account, transfer ownership.

There is no per-person spend report. Instance cards on My Instances show owner and group (for example General), plus runtime and hourly configuration, but not a team cost rollup. Docs: https://vm-docs.massedcompute.com/docs/running-instances/instance-elements

Team members and instance groups are not exposed through the REST API or MCP. See [massed-api-findings.md](../massed-api-findings.md).

## Massed MCP (assistant, not a product)

https://github.com/Massed-Compute/massed-compute-mcp is a verbatim proxy of `https://vm.massedcompute.com/api/mcp`. It lets Claude, Cursor, Codex, or ChatGPT list GPU inventory, list and manage VMs, manage SSH keys, and read billing settings. Docs: https://vm-docs.massedcompute.com/docs/mcp/overview

Auth is either an API key (Settings → API) or an OAuth grant. OAuth grants show up under Settings → Connected Apps and can be read-only or full access. See [massed-api-findings.md](../massed-api-findings.md).

Their `mc-cost-control` skill (https://vm-docs.massedcompute.com/skills/mc-cost-control.md) estimates the current hourly burn:

1. `instances_list` for running VMs.
2. `gpu_inventory_list` for per-SKU price.
3. `account_billing` for recharge amount and threshold, then a runway estimate until the next recharge.

It does not terminate instances. It is a chat workflow, not a dashboard. It cannot see account balance, past charges, terminated VMs, or who launched a VM.

The Massed-Compute GitHub org (https://github.com/Massed-Compute) has three repositories and nothing else built for teams or usage history:

| Repo | What it is |
|------|------------|
| `gpu-benchmark` | Shell benchmarks across GPU types |
| `massed-compute-mcp` | MCP proxy described above |
| `massed-compute-agent-plugin` | Claude Code / Cowork plugin, marked private draft, not submitted |

## Public price sites

These compare Massed's catalog rates. They do not connect to an account.

- https://gputracker.dev/provider/massed-compute
- https://cloud-gpus.com/providers/massedcompute/
- https://getdeploying.com/massed-compute
- https://www.spheron.network/blog/massed-compute-pricing-2026/

## Why an outside tracker cannot close the gap from the API

The REST API and MCP do not expose balance, transactions, invoices, usage history, terminated-VM history, or team membership. The dollar balance and Stripe receipts exist only on the logged-in `/billing` page, which needs the session cookie. Details and confidence levels are in [massed-api-findings.md](../massed-api-findings.md).

Connected Apps (OAuth) is the correct way for each person to connect their own Massed account to an app. The token works only on MCP, not on `/api/v1`. A pasted API key remains the path for one operator credential. Either grant still cannot read balance, transactions, or team membership.

## Searches that did not turn up a Massed-specific product

Queries that returned generic workforce trackers, other clouds, or unrelated MCP cost tools, and no Massed account product:

- Massed Compute team management usage tracking dashboard app
- "massed compute" team OR billing tracker OR GPU dashboard github
- Massed Compute MCP client team OR spend OR "cost tracking" app
- github massedcompute OR "massed compute" dashboard OR spend OR team instance tracker

Unrelated hits worth not confusing with this problem: TMetric, Monitask, and Mera Monitor (employee time tracking); Google Cloud fleet team dashboards; MCPSpend (cost of MCP tool calls, not GPU hours); InfraDash (AWS, GCP, OCI, Azure, DigitalOcean, not Massed); Brev's Go client for the Massed inventory API (a provider integration, not a team tracker).
