# Runbook: billing-api

Owner: finance-platform. Tier 2 service. Handles POST /invoices.

## Known failure modes

- Payment provider timeouts surface as ProviderTimeoutError from `billing/provider.py`; retry, do not roll back.

## Rollback

Redeploy the previous release tag.
