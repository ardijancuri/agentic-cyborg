# Personal Software Assistant

Reusable business AI assistant foundation for custom software, CRMs, CMSs, ecommerce sites, and web apps.

This project is the portable home for the assistant that was first tested inside `crm-invoice-gold-services`.
It is designed to be installed as a private npm addon: `@oninova/personal-software-assistant`.

## What This Provides

- A generic assistant service with conversation history, message storage, Markdown context storage, draft actions, and tool-run logs.
- A PostgreSQL schema for assistant tables.
- An OpenAI Responses API provider that uses approved function tools and structured draft actions.
- A generic Express router factory for host backends.
- A standard role guard and read-only tool registry helper for project adapters.
- Optional approved write-action registry support for user-reviewed business edits.
- A generic React floating assistant drawer for host frontends.
- An Argjira CRM adapter example and a Node/React/Postgres starter template.

## Core Idea

Each host app provides:

1. `pool`: a PostgreSQL pool or client.
2. `toolRegistry`: approved read-only tools for that app's database.
3. `contextSources`: functions that generate Markdown context documents from deterministic data.
4. `pageRegistry`: the host app's real frontend pages/routes for draft action links.
5. Optional `writeActionRegistry`: approved write handlers for reviewed actions like price edits.
6. Auth/role checks from the host application.

The assistant core handles:

- chat conversations
- Markdown context storage
- OpenAI tool orchestration
- draft action validation
- approved apply/reject state for write-capable draft actions
- audit-friendly tool-run storage

The model never executes raw SQL. It can only call tools exposed by the host adapter, and it cannot write to business tables directly. Write-capable actions are stored as draft cards and only run when the user clicks Apply.

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

const assistantService = createAssistantService({
  repository,
  toolRegistry,
  contextSources: createProjectContextSources(),
  pageRegistry: createProjectPageRegistry(),
  writeActionRegistry: createWriteActionRegistry({
    actions: [
      // Host apps add reviewed write handlers here.
      // Example: update_product_price -> update only the approved price column.
    ],
  }),
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
  getContext: () => api.get('/assistant/context').then((res) => res.data),
  refreshContext: () => api.post('/assistant/context/refresh').then((res) => res.data),
  applyDraftAction: (id) => api.post(`/assistant/draft-actions/${id}/apply`).then((res) => res.data),
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

Write actions are optional and project-specific. Each action has a stable `type`, a payload shape, allowed roles, and an `apply()` handler owned by the host app.

```js
const writeActionRegistry = createWriteActionRegistry({
  actions: [
    {
      type: 'update_product_price',
      handlerName: 'update_stock_item_price',
      description: 'Update one existing product/stock item price after full_admin approval.',
      requiredRoles: ['full_admin'],
      payloadSchema: {
        type: 'object',
        required: ['stockItemId', 'currentPrice', 'newPrice', 'currency', 'reason'],
      },
      apply: async ({ action, user, requestContext }) => {
        // Validate payload, check stale current price, update only the allowed price column,
        // then audit old price/new price/user/draft action id in the host application.
      },
    },
  ],
});
```

The assistant may propose `update_product_price`, but it must stay `requiresUserReview: true`. The backend stores it as `draft`; only `POST /api/assistant/draft-actions/:id/apply` can mark it `applied`.

## Environment Variables

```env
ASSISTANT_ENABLED=true
ASSISTANT_PROVIDER=openai
OPENAI_MODEL=gpt-5.4-mini
OPENAI_API_KEY=
ASSISTANT_MAX_TOOL_CALLS=4
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
- Add write handlers only for narrow, reviewed updates. Keep each handler role-aware, transactional, and audited.
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

## Test

```bash
npm test
```
