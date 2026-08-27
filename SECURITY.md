# Security

## Report a vulnerability

Please **do not** open a public issue for a leak or auth bug.

Use [GitHub security advisories](https://github.com/vasanthsreeram/mass-compute-management-ui/security/advisories/new) on this repository, or email the maintainer listed on the GitHub profile.

## Operator checklist

- Put `MASSED_COMPUTE_API_KEY`, `SESSION_SECRET`, and `DATA_KEY` in Wrangler secrets only.
- First user is admin. Treat that password like a root password.
- Rotate a user’s `gpk_` keys if a machine or chat log may have leaked them.
- The Massed key can terminate every VM on the operator account. Never give it to tenants or agents.

## What this proxy does not do

- Massed’s API has no wallet-balance endpoint. Do not scrape Massed’s login pages for dollars.
- Terminate is destructive (disk gone). Confirm in the UI / skill before calling it.
