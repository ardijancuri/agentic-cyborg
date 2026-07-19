# Assistant Capability Harness

Version 0.2 makes capabilities the integration contract for every host application.

## Capability Manifest

Read capabilities describe an approved tool:

```js
{
  mode: 'read',
  name: 'find_products',
  resource: 'product',
  requiredRoles: ['admin', 'full_admin']
}
```

Write capabilities describe a reviewed action:

```js
{
  type: 'bulk_update_product_inventory_by_category',
  mode: 'write',
  resource: 'inventory',
  scope: 'category',
  risk: 'high',
  requiredRoles: ['full_admin'],
  requiresReview: true,
  supportsPreview: true,
  maxBatchSize: 100,
  payloadSchema: {}
}
```

The manifest is available from `GET /api/assistant/capabilities` in Express hosts and `GET /wp-json/oninova-assistant/v1/capabilities` in WordPress.

## Write Lifecycle

1. The model may propose only a registered action type.
2. The host stores it as `draft` and attaches the capability metadata.
3. `POST .../draft-actions/:id/preview` resolves exact records and before/after values without writing.
4. Apply checks permissions again and atomically changes `draft|failed` to `applying`.
5. The adapter validates stale values, batch limits, fields, and host-specific constraints.
6. The adapter executes inside its transaction boundary.
7. The action becomes `applied` with preview/result metadata or `failed` with an error.

Reject also uses a conditional state transition, so it cannot race an in-progress apply.

## Host Adapter Rules

- The model never receives a raw SQL or arbitrary HTTP tool.
- Tool and action names must be registered by code owned by the host application.
- Every bulk action defines a hard `maxBatchSize`.
- Category/filter actions resolve targets on the server; the model supplies only an approved selector.
- Explicit item actions include current values when stale-write protection is required.
- Preview handlers are read-only and use the same validation rules as Apply.
- Apply handlers whitelist fields and use the host's transaction and audit facilities.
- New permissions are added by registering a capability, not by changing the generic router or chat UI.

## Product Operations

Shared price helpers support:

- `set`
- `increase_percent`
- `decrease_percent`
- `increase_fixed`
- `decrease_fixed`
- `set_percent_of_regular_price`
- `clear` for sale prices

The Node/PostgreSQL template maps those operations to whitelisted columns. The WooCommerce plugin maps them to `WC_Product` setters and saves through WooCommerce CRUD APIs.

## Central WooCommerce Service

The central runner filters site-supplied definitions through package-owned allowlists before giving them to the model. A site cannot introduce `run_sql`, arbitrary write types, or batch limits above the service defaults by changing its request payload.
