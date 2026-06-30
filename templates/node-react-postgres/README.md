# Node + React + PostgreSQL Assistant Addon Template

Copy `src/assistant` into the host backend and adjust the SQL table names inside `toolRegistry.js`.

Copy `src/frontend` into the host frontend or adapt it to the app's existing API/client layout.

Required host decisions:

- Which roles can use the assistant. V1 default: `admin`, `full_admin`.
- Which database tables each read-only tool can query.
- Which frontend routes belong in `pageRegistry.js`.
- Which existing audit logger should receive assistant events.

Do not expose a generic SQL tool. Add one bounded, parameterized read-only tool per business question area.

## Included Tool Examples

The starter includes parameterized read-only tools for:

- business overview
- sales and order statistics
- inventory and low-stock summaries
- unpaid invoices
- top products and product performance
- product and category comparisons
- customer order preferences
- deterministic marketing campaign recommendations

The SQL assumes common ecommerce-style tables such as `orders`, `order_items`, `products`, `categories`, `inventory_items`, and `invoices`. Adjust table and column names to the host app before production use.

## Included Reviewed Write Examples

The starter includes reviewed write handlers for:

- `update_product_price`
- `bulk_update_product_prices`
- `bulk_update_product_prices_by_category`
- `update_product_details`
- `bulk_update_product_details`
- `bulk_update_product_details_by_category`

Handlers use transactions, whitelisted columns, row locks, bounded batch sizes, and `full_admin` access by default. Category bulk price/detail handlers resolve products from `categoryId` or `categoryName`, so the user does not need to list every product ID. Product detail fields are limited to `name`, `sku`, `description`, `shortDescription`, `status`, and `categoryId` unless the host app expands the whitelist.

## Session Persistence

The React drawer keeps the active `conversationId` and a small recent-message cache in local storage for fast refresh recovery. Full conversation history remains in PostgreSQL and is reloaded through `GET /api/assistant/conversations/:id` when available.

## Charts And Readability

Assistant responses can include compact `charts` for numeric statistics, product/category comparisons, order trends, and performance summaries. The shared React drawer renders bar, line, and donut charts without requiring an extra charting dependency, and it auto-scrolls to the newest answer.
