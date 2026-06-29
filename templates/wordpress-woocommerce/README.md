# WordPress + WooCommerce Assistant Template

This template contains an installable WordPress plugin for WooCommerce stores.

## Install

1. Copy `oninova-personal-assistant` into `wp-content/plugins/`.
2. Activate **Oninova Personal Assistant for WooCommerce** in WordPress.
3. Open **WooCommerce > AI Assistant**.
4. Choose **Easy: WordPress calls OpenAI directly**.
5. Paste the OpenAI API key and save.

The plugin stores assistant state in WordPress custom tables and uses WooCommerce APIs for store data.

## Easy Mode

This is the recommended setup for a single WooCommerce store:

```text
WooCommerce > AI Assistant
Assistant mode: Easy
OpenAI API key: paste key
OpenAI model: gpt-5.4-mini
```

No Node service is required in this mode.
The API key is saved in WordPress options and is not exposed to the assistant chat JavaScript.

## Advanced Central Service

Use this when one hosted assistant service should support multiple stores or when the OpenAI key should not be stored in WordPress.

For local central-service testing, copy:

```text
templates/wordpress-woocommerce/.env.local.example
```

to:

```text
templates/wordpress-woocommerce/.env.local
```

Then fill in `OPENAI_API_KEY`, `WOO_ASSISTANT_SITE_ID`, and `WOO_ASSISTANT_SITE_SECRET`.

Start the local service:

```bash
npm run woo:service
```

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
- Approved single and bulk regular/sale price updates for simple products and variations. Bulk drafts are limited to 50 explicitly listed items.
- No stock writes, order status writes, customer edits, coupon edits, or sale schedules.
