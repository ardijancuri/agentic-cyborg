# Assistant Expanded Capabilities

## Summary

This update expands `personal-software-assistant` for WooCommerce and Node/React/PostgreSQL integrations. The assistant can now read richer business statistics, compare products and categories, recommend marketing campaign directions from order data, persist chat sessions across refreshes, and create reviewed bulk product write actions.

## Category Bulk Price Fix

- Added explicit category-wide price-write support so the assistant can draft price or sale-price updates for all products in a category.
- WooCommerce action type: `bulk_update_woocommerce_category_product_prices`.
- Generic action type: `bulk_update_product_prices_by_category`.
- The assistant prompt now says category bulk actions do not require every product ID when a category action is available.
- WooCommerce supports category payloads with `categoryId`, `categorySlug`, or `categoryName`.
- Category sale-price removal uses `priceField: "sale_price"` and `operation: "clear_sale_price"`.
- Applying the action still requires user review and WooCommerce permissions.

## WooCommerce Updates

- Added read-only tools for product categories, products by category, order statistics, product performance, product comparisons, category comparisons, customer order preferences, and marketing recommendations.
- Added approved write actions for single product prices, itemized bulk prices, category bulk prices, single product details, itemized bulk details, and category bulk details.
- Product price writes use WooCommerce CRUD APIs for simple products and variations.
- Product detail writes are limited to approved fields: `name`, `sku`, `shortDescription`, `description`, `status`, `featured`, and `catalogVisibility`.
- Context refresh now includes customer preference and marketing recommendation snapshots.
- The WordPress admin drawer restores the active conversation after page refresh using local storage plus WordPress conversation history.

## Node/React/PostgreSQL Template Updates

- Added ecommerce-style read tools for sales, orders, products, categories, customer preferences, and campaign recommendations.
- Added reviewed write handlers for product prices and product details, including category-level bulk handlers.
- Category handlers resolve products from `categoryId` or `categoryName`.
- Writes use transactions, row locks, whitelisted columns, and bounded batch sizes.
- Frontend integration now exposes `getConversation`/`getConversations` and supports persistent assistant sessions.

## Shared Package Updates

- Added new draft action types for category price writes and product detail writes.
- Updated prompt rules so the model proposes approved category actions instead of asking for product IDs.
- Updated React `AssistantButton` to persist recent session state and render richer write-action payload summaries.
- WooCommerce runner passes category write guidance to the provider.

## Safety Defaults

- All write actions remain draft-only until an authorized user clicks Apply.
- The model never writes directly to product, order, stock, customer, coupon, or payment tables.
- WooCommerce V1 still does not support stock writes, order status changes, customer edits, coupon edits, or sale schedules.
- Batch writes are bounded: 50 itemized products and 100 category-resolved products by default.

## Verification

- `npm run check`
- `npm test`
- `node --check templates/wordpress-woocommerce/oninova-personal-assistant/assets/admin.js`
- `node --check templates/node-react-postgres/src/assistant/toolRegistry.js`
- `node --check templates/node-react-postgres/src/assistant/writeActionRegistry.js`
- PHP lint for `templates/wordpress-woocommerce/oninova-personal-assistant/oninova-personal-assistant.php`

## Testing In WordPress

After installing the rebuilt plugin, ask:

```text
Remove sale prices from all Tekstil category products.
```

Expected behavior:

- The assistant should not ask you to send all product IDs.
- It should resolve the category using approved tools.
- It should return a reviewed category bulk sale-price draft action.
- Clicking Apply should clear sale prices only after WordPress/WooCommerce permission checks pass.
