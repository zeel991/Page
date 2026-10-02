# Runbook: orders-api

Owner: commerce-team. Tier 1 service. Handles POST /orders.

## Known failure modes

- Inventory service outages surface as InventoryUnavailableError from `src/inventory.js`, with 503s upstream. Do not roll back.

## Rollback

Redeploy the previous release tag.
