# Personal Software Assistant

The reusable capability and reviewed-write contract is documented in [docs/capability-harness.md](docs/capability-harness.md).

Reusable business AI assistant foundation for custom software, CRMs, CMSs, ecommerce sites, and web apps.

This project is the portable home for the assistant that was first tested inside `crm-invoice-gold-services`.
It is designed to be installed as a private npm addon: `@oninova/personal-software-assistant`.

## What This Provides

- A generic assistant service with conversation history, message storage, Markdown context storage, draft actions, and tool-run logs.
- A PostgreSQL schema for assistant tables.
- An OpenAI Responses API provider that uses approved function tools and structured draft actions.
- A generic Express router factory for host backends.
- A standard role guard and read-only tool registry helper for project adapters.
- A capability harness for role-aware tools, reviewed writes, server previews, batch limits, and auditable action state transitions.
- A generic React floating assistant drawer for host frontends, with readable Markdown, chart rendering, and refresh-safe sessions.
- A WooCommerce integration template with a WordPress plugin and central Node service runner.
- An Argjira CRM adapter example and a Node/React/Postgres starter template.
- Session persistence in the frontend drawer: only the active `conversationId` and a short recent-message cache are stored locally, while full history stays in the backend tables.
- Compact chart specs in assistant responses for statistics, trends, product/category comparisons, and order performance.

## Core Idea

Each host app provides:

1. `pool`: a PostgreSQL pool or client.
2. `toolRegistry`: approved read-only tools for that app's database.
3. `contextSources`: functions that generate Markdown context documents from deterministic data.
4. `pageRegistry`: the host app's real frontend pages/routes for draft action links.
5. Optional `writeActionRegistry`: approved write handlers with resource, scope, risk, roles, limits, preview, and apply contracts.
6. `capabilityHarness`: the shared manifest used by the prompt, API, audit trail, and UI.
7. Auth/role checks from the host application.

The assistant core handles:

- chat conversations
- Markdown context storage
- OpenAI tool orchestration
- draft action validation
- approved preview/apply/reject state for write-capable draft actions
- atomic `draft -> applying -> applied|failed` transitions when the repository supports them
- audit-friendly tool-run storage

The model never executes raw SQL. It can only call tools exposed by the host adapter, and it cannot write to business tables directly. Write-capable actions are stored as draft cards and only run when the user clicks Apply.

## WooCommerce Integration

WooCommerce supports two install modes:

- Easy mode: the WordPress plugin calls OpenAI directly after the store manager pastes an API key in **WooCommerce > AI Assistant**.
- Advanced mode: the WordPress plugin calls a central Node assistant service for multi-site deployments or when you do not want OpenAI keys stored in WordPress.

- WordPress stores assistant conversations, messages, context documents, draft actions, and tool runs in custom `{prefix}psa_assistant_*` tables.
- WordPress exposes `/wp-json/oninova-assistant/v1/*` endpoints for the admin drawer and signed tool callbacks.
- WooCommerce data access stays inside the plugin through WooCommerce/WordPress APIs.
- Read tools include order statistics, product/category comparisons, customer order preferences, and deterministic marketing campaign recommendations.
- The admin chat drawer renders Markdown, reviewed action cards, and compact bar/line/donut charts for numeric statistics.
- Product write support includes reviewed single, itemized bulk, and category bulk prices, catalog details, and inventory settings.
- The central service clamps site-supplied tools and writes to a package-owned WooCommerce capability allowlist.

Plugin template:

```text
templates/wordpress-woocommerce/oninova-personal-assistant/
```

Central service sketch:

```js
import express from 'express';
import { createWooCommerceAssistantServiceRouter } from '@oninova/personal-software-assistant/woocommerce';

const app = express();

app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = buffer.toString('utf8');
  },
}));

app.use(createWooCommerceAssistantServiceRouter({
  express,
  requireSignature: true,
  getSiteSecret: async (siteId) => {
    return process.env[`WOO_ASSISTANT_SECRET_${siteId}`];
  },
}));
```

The WordPress plugin sends only signed requests to the central service. The service uses the shared site secret to sign tool callbacks back to WordPress.

## Install As Addon

Private npm package default:

```bash
npm install @oninova/personal-software-assistant
```

For local development before publishing, install from the local folder:

```bash
npm install "file:C:/Users/PC/Documents/personal-software-assistant"
```

## PostgreSQL Tables

Apply:

```bash
psql "$DATABASE_URL" -f node_modules/@oninova/personal-software-assistant/sql/postgres/001_assistant_tables.sql
```

Tables created:

- `assistant_conversations`
- `assistant_messages`
- `assistant_context_documents`
- `assistant_draft_actions`
- `assistant_tool_runs`

## Backend Integration Sketch

```js
import express from 'express';
import { Pool } from 'pg';
import {
  createAssistantRoleAuthorize,
  createAssistantCapabilityHarness,
  createAssistantRouter,
  createAssistantService,
  createPostgresAssistantRepository,
  createWriteActionRegistry,
  readAssistantConfig,
} from '@oninova/personal-software-assistant';
import { createProjectToolRegistry } from './assistant/toolRegistry.js';
import { createProjectContextSources } from './assistant/contextSources.js';
import { createProjectPageRegistry } from './assistant/pageRegistry.js';
import { createProjectAuditLogger } from './assistant/auditLogger.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const repository = createPostgresAssistantRepository({ pool });
const toolRegistry = createProjectToolRegistry({ pool });
const writeActionRegistry = createWriteActionRegistry({ actions: [] });

const assistantService = createAssistantService({
  repository,
  toolRegistry,
  contextSources: createProjectContextSources(),
  pageRegistry: createProjectPageRegistry(),
  writeActionRegistry,
  capabilityHarness: createAssistantCapabilityHarness({ toolRegistry, writeActionRegistry }),
  fallbackRoute: '/dashboard',
  config: readAssistantConfig(process.env),
  appName: 'Project Name',
  auditLogger: createProjectAuditLogger(),
});

app.use('/api/assistant', createAssistantRouter({
  express,
  service: assistantService,
  authenticate,
  authorize: createAssistantRoleAuthorize(),
}));
```

## Frontend Integration Sketch

```jsx
import AssistantButton from '@oninova/personal-software-assistant/react';
import '@oninova/personal-software-assistant/react/styles.css';

const assistantApi = {
  chat: (data) => api.post('/assistant/chat', data).then((res) => res.data),
  getConversations: () => api.get('/assistant/conversations').then((res) => res.data),
  getConversation: (id) => api.get(`/assistant/conversations/${id}`).then((res) => res.data),
  getContext: () => api.get('/assistant/context').then((res) => res.data),
  getCapabilities: () => api.get('/assistant/capabilities').then((res) => res.data),
  refreshContext: () => api.post('/assistant/context/refresh').then((res) => res.data),
  applyDraftAction: (id) => api.post(`/assistant/draft-actions/${id}/apply`).then((res) => res.data),
  previewDraftAction: (id) => api.post(`/assistant/draft-actions/${id}/preview`).then((res) => res.data),
  rejectDraftAction: (id) => api.post(`/assistant/draft-actions/${id}/reject`).then((res) => res.data),
};

<AssistantButton
  api={assistantApi}
  canUseAssistant={user.role === 'admin' || user.role === 'full_admin'}
  canApplyActions={user.role === 'full_admin'}
  locale={language}
/>;
```

## Approved Write Actions

Write actions are optional and project-specific. Each action has a stable `type`, resource/scope/risk metadata, a payload shape, allowed roles, a batch limit, a read-only `preview()` handler, and an `apply()` handler owned by the host app.

```js
const writeActionRegistry = createWriteActionRegistry({
  actions: [
    {
      type: 'update_product_price',
      handlerName: 'update_stock_item_price',
      description: 'Update one existing product/stock item price after full_admin approval.',
      resource: 'product',
      scope: 'single',
      risk: 'medium',
      maxBatchSize: 1,
      requiredRoles: ['full_admin'],
      payloadSchema: {
        type: 'object',
        required: ['stockItemId', 'currentPrice', 'newPrice', 'currency', 'reason'],
      },
      preview: async ({ action, user, requestContext }) => {
        // Resolve the current row and return exact before/after values without writing.
      },
      apply: async ({ action, preview, user, requestContext }) => {
        // Validate payload, check stale current price, update only the allowed price column,
        // then audit old price/new price/user/draft action id in the host application.
      },
    },
    {
      type: 'bulk_update_product_prices',
      handlerName: 'bulk_update_product_prices',
      description: 'Update approved price fields for an explicit, bounded list of products after full_admin approval.',
      requiredRoles: ['full_admin'],
      payloadSchema: {
        type: 'object',
        required: ['items', 'currency', 'reason'],
      },
      apply: async ({ action, user, requestContext }) => {
        // Validate every listed item, check stale current prices, update only approved price columns
        // in a transaction, then audit the full before/after result.
      },
    },
    {
      type: 'bulk_update_product_prices_by_category',
      handlerName: 'bulk_update_product_prices_by_category',
      description: 'Update approved price fields for all products in one resolved category after full_admin approval.',
      requiredRoles: ['full_admin'],
      payloadSchema: {
        type: 'object',
        required: ['categoryName', 'priceField', 'operation', 'currency', 'maxItems', 'reason'],
      },
      apply: async ({ action, user, requestContext }) => {
        // Resolve the category through approved app APIs, bound the item count,
        // validate the pricing operation, update in a transaction, then audit every changed row.
      },
    },
  ],
});
```

The assistant may propose `update_product_price`, `bulk_update_product_prices`, or `bulk_update_product_prices_by_category`, but they must stay `requiresUserReview: true`. The backend stores them as `draft`; only `POST /api/assistant/draft-actions/:id/apply` can mark them `applied`.

Product detail write actions follow the same rule. Standard action names are:

- `update_product_details`
- `bulk_update_product_details`
- `bulk_update_product_details_by_category`

Host apps must whitelist editable fields and validate every change before saving. The Node/Postgres template includes a conservative example for `name`, `sku`, `description`, `shortDescription`, `status`, and `categoryId`.

Inventory write actions use the same reviewed lifecycle:

- `update_product_inventory`
- `bulk_update_product_inventory`
- `bulk_update_product_inventory_by_category`

The Node/PostgreSQL template limits inventory fields to `quantity` and `reorderLevel`. WooCommerce additionally supports `manageStock`, `stockQuantity`, `stockStatus`, `backorders`, and `lowStockAmount` through WooCommerce CRUD APIs.

## Environment Variables

```env
ASSISTANT_ENABLED=true
ASSISTANT_PROVIDER=openai
OPENAI_MODEL=gpt-5.4-mini
OPENAI_API_KEY=
ASSISTANT_MAX_TOOL_CALLS=4
ASSISTANT_MAX_BULK_ITEMS=100
ASSISTANT_ACTION_PREVIEW_LIMIT=20
```

If `OPENAI_API_KEY` is missing, the assistant still mounts and stores history, but chat returns a controlled setup message.

## Adapter Checklist For A New App

- Copy `templates/node-react-postgres/src/assistant` into the host backend as `src/assistant`.
- Define the business areas the owner should ask about.
- Create one tool per safe read-only business query.
- Keep tools parameterized and row-limited.
- Generate Markdown context from stable business summaries.
- Register real frontend routes in `pageRegistry`; draft actions are clamped to those routes.
- Create draft action types that only guide users to existing screens.
- Add write handlers only for reviewed updates. Define resource, scope, risk, roles, batch limit, preview, validation, transaction, and audit behavior.
- For ecommerce/CRM apps, add read tools for product performance, category comparison, order statistics, customer preferences, and marketing recommendations.
- Add role checks before mounting `/api/assistant`.
- Apply the assistant SQL schema in that app's database.

Recommended host structure:

```text
src/assistant/
  assistantService.js
  toolRegistry.js
  contextSources.js
  pageRegistry.js
  auditLogger.js
```

The starter template lives in:

```text
templates/node-react-postgres/
```

WooCommerce template lives in:

```text
templates/wordpress-woocommerce/
```

## Test

```bash
npm test
```
