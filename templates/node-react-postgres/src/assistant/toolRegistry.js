import {
  clampToolLimit,
  createReadOnlyToolRegistry,
} from '@oninova/personal-software-assistant';

const periodStart = (period = 'month') => {
  const normalized = ['today', 'week', 'month', 'year', 'all'].includes(period) ? period : 'month';
  const now = new Date();
  const from = new Date(now);

  if (normalized === 'today') {
    from.setHours(0, 0, 0, 0);
  } else if (normalized === 'week') {
    from.setDate(now.getDate() - 7);
  } else if (normalized === 'month') {
    from.setMonth(now.getMonth() - 1);
  } else if (normalized === 'year') {
    from.setFullYear(now.getFullYear() - 1);
  } else {
    from.setFullYear(2020, 0, 1);
    from.setHours(0, 0, 0, 0);
  }

  return from;
};

const previousPeriodStart = (period = 'month') => {
  const currentStart = periodStart(period);
  const now = new Date();
  const durationMs = Math.max(1, now.getTime() - currentStart.getTime());
  return new Date(currentStart.getTime() - durationMs);
};

const normalizeIds = (values = [], limit = 20) => {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
    .slice(0, limit);
};

export const createProjectToolRegistry = ({ pool }) => {
  if (!pool?.query) {
    throw new Error('createProjectToolRegistry requires a PostgreSQL pool/client');
  }

  return createReadOnlyToolRegistry({
    tools: [
      {
        name: 'get_business_overview',
        description: 'Read-only overview of core business totals.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async handler() {
          const result = await pool.query(`
            SELECT
              (SELECT COUNT(*)::int FROM orders) AS orders,
              (SELECT COALESCE(SUM(total), 0) FROM orders WHERE status != 'cancelled') AS revenue,
              (SELECT COALESCE(SUM(quantity * cost), 0) FROM inventory_items) AS "inventoryValue"
          `);

          return result.rows[0] || {};
        },
      },
      {
        name: 'get_sales_summary',
        description: 'Read-only sales and revenue totals for a selected period.',
        parameters: {
          type: 'object',
          properties: { period: { type: 'string', enum: ['today', 'week', 'month', 'year', 'all'] } },
          additionalProperties: false,
        },
        async handler({ period = 'month' } = {}) {
          const from = periodStart(period);
          const result = await pool.query(`
            SELECT
              COUNT(*)::int AS orders,
              COALESCE(SUM(total), 0) AS revenue,
              COALESCE(AVG(total), 0) AS "averageOrder"
            FROM orders
            WHERE status != 'cancelled'
              AND created_at >= $1
          `, [from]);

          return { period, summary: result.rows[0] || {} };
        },
      },
      {
        name: 'get_inventory_summary',
        description: 'Read-only inventory totals and low-stock products.',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } },
          additionalProperties: false,
        },
        async handler({ limit = 10 } = {}) {
          const safeLimit = clampToolLimit(limit, 10, 20);
          const totals = await pool.query(`
            SELECT COUNT(*)::int AS "productCount"
            FROM products
          `);
          const lowStock = await pool.query(`
            SELECT p.name, p.sku, i.quantity
            FROM inventory_items i
            JOIN products p ON p.id = i.product_id
            WHERE i.quantity <= COALESCE(i.reorder_level, 5)
            ORDER BY i.quantity ASC
            LIMIT $1
          `, [safeLimit]);

          return {
            ...(totals.rows[0] || {}),
            lowStock: lowStock.rows,
          };
        },
      },
      {
        name: 'find_products',
        title: 'Find products for review or editing',
        resource: 'product',
        description: 'Read-only product lookup with ids, category, prices, quantity, and reorder level for reviewed product actions.',
        parameters: {
          type: 'object',
          properties: {
            search: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
        async handler({ search = '', limit = 10 } = {}) {
          const safeLimit = clampToolLimit(limit, 10, 50);
          const term = `%${String(search || '').trim()}%`;
          const result = await pool.query(`
            SELECT
              p.id::text AS "productId",
              p.name,
              p.sku,
              p.price,
              p.sale_price AS "salePrice",
              p.status,
              p.category_id::text AS "categoryId",
              c.name AS "categoryName",
              i.quantity,
              i.reorder_level AS "reorderLevel"
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN inventory_items i ON i.product_id = p.id
            WHERE p.name ILIKE $1 OR COALESCE(p.sku, '') ILIKE $1
            ORDER BY p.name ASC
            LIMIT $2
          `, [term, safeLimit]);

          return { search: String(search || ''), products: result.rows };
        },
      },
      {
        name: 'get_product_categories',
        title: 'Find product categories',
        resource: 'product_category',
        description: 'Read-only product category lookup with product counts before category bulk actions.',
        parameters: {
          type: 'object',
          properties: {
            search: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
        async handler({ search = '', limit = 20 } = {}) {
          const safeLimit = clampToolLimit(limit, 20, 50);
          const term = `%${String(search || '').trim()}%`;
          const result = await pool.query(`
            SELECT c.id::text AS "categoryId", c.name, COUNT(p.id)::int AS "productCount"
            FROM categories c
            LEFT JOIN products p ON p.category_id = c.id
            WHERE c.name ILIKE $1
            GROUP BY c.id, c.name
            ORDER BY c.name ASC
            LIMIT $2
          `, [term, safeLimit]);

          return { search: String(search || ''), categories: result.rows };
        },
      },
      {
        name: 'find_products_by_category',
        title: 'Resolve category products',
        resource: 'product',
        description: 'Read-only bounded product list for one category with current prices and inventory values.',
        parameters: {
          type: 'object',
          properties: {
            categoryId: { type: 'string' },
            categoryName: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
        async handler({ categoryId = '', categoryName = '', limit = 20 } = {}) {
          if (!String(categoryId).trim() && !String(categoryName).trim()) {
            const error = new Error('Category id or category name is required');
            error.status = 400;
            throw error;
          }
          const safeLimit = clampToolLimit(limit, 20, 100);
          const result = await pool.query(`
            SELECT
              p.id::text AS "productId",
              p.name,
              p.sku,
              p.price,
              p.sale_price AS "salePrice",
              p.status,
              c.id::text AS "categoryId",
              c.name AS "categoryName",
              i.quantity,
              i.reorder_level AS "reorderLevel"
            FROM products p
            JOIN categories c ON c.id = p.category_id
            LEFT JOIN inventory_items i ON i.product_id = p.id
            WHERE ($1 = '' OR c.id::text = $1)
              AND ($2 = '' OR LOWER(c.name) = LOWER($2))
            ORDER BY p.name ASC
            LIMIT $3
          `, [String(categoryId || ''), String(categoryName || ''), safeLimit + 1]);

          return {
            categoryId: categoryId || null,
            categoryName: categoryName || null,
            limit: safeLimit,
            truncated: result.rows.length > safeLimit,
            products: result.rows.slice(0, safeLimit),
          };
        },
      },
      {
        name: 'get_unpaid_invoices',
        description: 'Read-only list of unpaid invoices or order balances.',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } },
          additionalProperties: false,
        },
        async handler({ limit = 10 } = {}) {
          const safeLimit = clampToolLimit(limit, 10, 20);
          const result = await pool.query(`
            SELECT number, customer_name, balance, due_date
            FROM invoices
            WHERE balance > 0
            ORDER BY due_date NULLS LAST, created_at DESC
            LIMIT $1
          `, [safeLimit]);

          return { limit: safeLimit, invoices: result.rows };
        },
      },
      {
        name: 'get_top_products',
        description: 'Read-only top product sales by revenue for a selected period.',
        parameters: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['today', 'week', 'month', 'year', 'all'] },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
          },
          additionalProperties: false,
        },
        async handler({ period = 'month', limit = 10 } = {}) {
          const safeLimit = clampToolLimit(limit, 10, 20);
          const from = periodStart(period);
          const result = await pool.query(`
            SELECT p.name, p.sku, SUM(oi.quantity)::numeric AS quantity, SUM(oi.total)::numeric AS revenue
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            JOIN products p ON p.id = oi.product_id
            WHERE o.status != 'cancelled'
              AND o.created_at >= $1
            GROUP BY p.id, p.name, p.sku
            ORDER BY revenue DESC
            LIMIT $2
          `, [from, safeLimit]);

          return { period, limit: safeLimit, products: result.rows };
        },
      },
      {
        name: 'get_order_statistics',
        description: 'Read-only order statistics with optional previous-period comparison.',
        parameters: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['today', 'week', 'month', 'year', 'all'] },
            comparePrevious: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        async handler({ period = 'month', comparePrevious = false } = {}) {
          const from = periodStart(period);
          const current = await pool.query(`
            SELECT
              COUNT(*)::int AS "orderCount",
              COALESCE(SUM(total), 0)::numeric AS revenue,
              COALESCE(AVG(total), 0)::numeric AS "averageOrderValue",
              COUNT(DISTINCT customer_id)::int AS "uniqueCustomers"
            FROM orders
            WHERE status != 'cancelled'
              AND created_at >= $1
          `, [from]);
          const data = { period, from, ...(current.rows[0] || {}) };

          if (comparePrevious && period !== 'all') {
            const previousFrom = previousPeriodStart(period);
            const previous = await pool.query(`
              SELECT
                COUNT(*)::int AS "orderCount",
                COALESCE(SUM(total), 0)::numeric AS revenue
              FROM orders
              WHERE status != 'cancelled'
                AND created_at >= $1
                AND created_at < $2
            `, [previousFrom, from]);
            data.previousPeriod = previous.rows[0] || {};
          }

          return data;
        },
      },
      {
        name: 'get_product_performance',
        description: 'Read-only product performance ranked by revenue or quantity.',
        parameters: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['today', 'week', 'month', 'year', 'all'] },
            categoryId: { type: 'string' },
            sortBy: { type: 'string', enum: ['revenue', 'quantity'] },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
        async handler({ period = 'month', categoryId = '', sortBy = 'revenue', limit = 10 } = {}) {
          const safeLimit = clampToolLimit(limit, 10, 50);
          const from = periodStart(period);
          const orderBy = sortBy === 'quantity' ? 'quantity' : 'revenue';
          const result = await pool.query(`
            SELECT
              p.id::text AS "productId",
              p.name,
              p.sku,
              p.category_id::text AS "categoryId",
              SUM(oi.quantity)::numeric AS quantity,
              SUM(oi.total)::numeric AS revenue,
              CASE WHEN SUM(oi.quantity) > 0 THEN SUM(oi.total) / SUM(oi.quantity) ELSE 0 END::numeric AS "averageSoldPrice"
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            JOIN products p ON p.id = oi.product_id
            WHERE o.status != 'cancelled'
              AND o.created_at >= $1
              AND ($2 = '' OR p.category_id::text = $2)
            GROUP BY p.id, p.name, p.sku, p.category_id
            ORDER BY ${orderBy} DESC
            LIMIT $3
          `, [from, String(categoryId || ''), safeLimit]);

          return { period, sortBy: orderBy, categoryId: categoryId || null, products: result.rows };
        },
      },
      {
        name: 'compare_products',
        description: 'Read-only comparison of selected products by quantity, revenue, and average sold price.',
        parameters: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['today', 'week', 'month', 'year', 'all'] },
            productIds: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        async handler({ period = 'month', productIds = [] } = {}) {
          const ids = normalizeIds(productIds, 20);
          if (!ids.length) {
            return { period, products: [] };
          }
          const from = periodStart(period);
          const result = await pool.query(`
            SELECT
              p.id::text AS "productId",
              p.name,
              p.sku,
              COALESCE(SUM(oi.quantity), 0)::numeric AS quantity,
              COALESCE(SUM(oi.total), 0)::numeric AS revenue,
              CASE WHEN COALESCE(SUM(oi.quantity), 0) > 0 THEN SUM(oi.total) / SUM(oi.quantity) ELSE 0 END::numeric AS "averageSoldPrice"
            FROM products p
            LEFT JOIN order_items oi ON oi.product_id = p.id
            LEFT JOIN orders o ON o.id = oi.order_id AND o.status != 'cancelled' AND o.created_at >= $1
            WHERE p.id::text = ANY($2::text[])
            GROUP BY p.id, p.name, p.sku
            ORDER BY revenue DESC
          `, [from, ids]);

          return { period, products: result.rows };
        },
      },
      {
        name: 'compare_categories',
        description: 'Read-only comparison of selected product categories by quantity and revenue.',
        parameters: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['today', 'week', 'month', 'year', 'all'] },
            categoryIds: { type: 'array', items: { type: 'string' } },
            categoryNames: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        async handler({ period = 'month', categoryIds = [], categoryNames = [] } = {}) {
          const ids = normalizeIds(categoryIds, 20);
          const names = normalizeIds(categoryNames, 20);
          const from = periodStart(period);
          const result = await pool.query(`
            SELECT
              c.id::text AS "categoryId",
              c.name,
              COALESCE(SUM(oi.quantity), 0)::numeric AS quantity,
              COALESCE(SUM(oi.total), 0)::numeric AS revenue
            FROM categories c
            LEFT JOIN products p ON p.category_id = c.id
            LEFT JOIN order_items oi ON oi.product_id = p.id
            LEFT JOIN orders o ON o.id = oi.order_id AND o.status != 'cancelled' AND o.created_at >= $1
            WHERE (cardinality($2::text[]) = 0 OR c.id::text = ANY($2::text[]))
              AND (cardinality($3::text[]) = 0 OR c.name = ANY($3::text[]))
            GROUP BY c.id, c.name
            ORDER BY revenue DESC
            LIMIT 20
          `, [from, ids, names]);

          return { period, categories: result.rows };
        },
      },
      {
        name: 'get_customer_order_preferences',
        description: 'Read-only summary of what customers order most and repeat-customer behavior.',
        parameters: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['today', 'week', 'month', 'year', 'all'] },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
          },
          additionalProperties: false,
        },
        async handler({ period = 'month', limit = 10 } = {}) {
          const safeLimit = clampToolLimit(limit, 10, 20);
          const from = periodStart(period);
          const topProducts = await pool.query(`
            SELECT p.name, p.sku, SUM(oi.quantity)::numeric AS quantity, SUM(oi.total)::numeric AS revenue
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            JOIN products p ON p.id = oi.product_id
            WHERE o.status != 'cancelled' AND o.created_at >= $1
            GROUP BY p.id, p.name, p.sku
            ORDER BY quantity DESC
            LIMIT $2
          `, [from, safeLimit]);
          const customerStats = await pool.query(`
            WITH customer_counts AS (
              SELECT customer_id, COUNT(*)::int AS order_count
              FROM orders
              WHERE status != 'cancelled' AND created_at >= $1 AND customer_id IS NOT NULL
              GROUP BY customer_id
            )
            SELECT
              COUNT(*)::int AS "uniqueCustomers",
              COUNT(*) FILTER (WHERE order_count > 1)::int AS "repeatCustomers"
            FROM customer_counts
          `, [from]);

          return {
            period,
            topProducts: topProducts.rows,
            ...(customerStats.rows[0] || {}),
          };
        },
      },
      {
        name: 'get_marketing_campaign_recommendations',
        description: 'Read-only deterministic marketing campaign recommendations from sales, product, category, and stock statistics.',
        parameters: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['week', 'month', 'year'] },
            limit: { type: 'integer', minimum: 1, maximum: 10 },
          },
          additionalProperties: false,
        },
        async handler({ period = 'month', limit = 5 } = {}) {
          const safeLimit = clampToolLimit(limit, 5, 10);
          const topProducts = await pool.query(`
            SELECT p.id::text AS "productId", p.name, p.sku, SUM(oi.quantity)::numeric AS quantity, SUM(oi.total)::numeric AS revenue
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            JOIN products p ON p.id = oi.product_id
            WHERE o.status != 'cancelled' AND o.created_at >= $1
            GROUP BY p.id, p.name, p.sku
            ORDER BY revenue DESC
            LIMIT $2
          `, [periodStart(period), safeLimit]);
          const lowStock = await pool.query(`
            SELECT p.name, p.sku, i.quantity
            FROM inventory_items i
            JOIN products p ON p.id = i.product_id
            WHERE i.quantity <= COALESCE(i.reorder_level, 5)
            ORDER BY i.quantity ASC
            LIMIT $1
          `, [safeLimit]);
          const recommendations = [];

          if (topProducts.rows[0]) {
            recommendations.push({
              type: 'bestseller_campaign',
              title: 'Promote the strongest product',
              reason: `${topProducts.rows[0].name} has the highest revenue in the selected period.`,
              target: topProducts.rows[0],
            });
          }

          if (lowStock.rows.length) {
            recommendations.push({
              type: 'stock_safe_campaign',
              title: 'Avoid low-stock campaign targets',
              reason: 'Some products are low stock and should be excluded from paid campaigns.',
              target: lowStock.rows,
            });
          }

          return { period, recommendations };
        },
      },
    ],
  });
};
