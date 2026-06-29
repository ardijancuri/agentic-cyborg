# WordPress + WooCommerce Assistant Template

This template contains an installable WordPress plugin for WooCommerce stores.

## Install

1. Copy `oninova-personal-assistant` into `wp-content/plugins/`.
2. Activate **Oninova Personal Assistant for WooCommerce** in WordPress.
3. Open **WooCommerce > AI Assistant**.
4. Configure:
   - Assistant service URL, for example `https://assistant.example.com`.
   - Site ID.
   - Site secret.

The plugin stores assistant state in WordPress custom tables and calls a central Node service that owns the OpenAI API key.

## Central Service

Mount the package router in a Node/Express service:

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
    // Load the shared secret for this site from the central service config/database.
    return process.env[`WOO_ASSISTANT_SECRET_${siteId}`];
  },
}));
```

## V1 Scope

- Read-only WooCommerce summaries and product lookup tools.
- Markdown context stored in WordPress custom tables.
- Draft actions stored in WordPress custom tables.
- Approved regular/sale price updates for simple products and variations.
- No stock writes, order status writes, customer edits, coupon edits, or sale schedules.
