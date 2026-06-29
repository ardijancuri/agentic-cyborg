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
    ],
  });
};
