import { createReadOnlyToolRegistry } from '../../src/adapters/readOnlyToolRegistry.js';

const PERIODS = new Set(['today', 'week', 'month', 'year', 'all']);

const normalizePeriod = (period) => PERIODS.has(period) ? period : 'month';

const periodStart = (period = 'month') => {
  const normalized = normalizePeriod(period);
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

const clampLimit = (value, fallback = 10, max = 50) => {
  const numeric = parseInt(value, 10);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(1, Math.min(numeric, max));
};

const toolDefinitions = [
  {
    type: 'function',
    name: 'get_business_overview',
    description: 'Read-only overview of company settings and top dashboard metrics.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_sales_summary',
    description: 'Read-only sales, payment, product, and revenue totals for a period.',
    parameters: {
      type: 'object',
      properties: { period: { type: 'string', enum: ['today', 'week', 'month', 'year', 'all'] } },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_stock_summary',
    description: 'Read-only inventory value, low-stock, category, and warehouse summaries.',
    parameters: {
      type: 'object',
      properties: { warehouse: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_unpaid_invoices',
    description: 'Read-only list of unpaid outgoing invoices and balances.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } },
      additionalProperties: false,
    },
  },
];

export const createArgjiraCrmToolRegistry = ({ pool }) => {
  const handlers = {
    async get_business_overview() {
      const company = await pool.query('SELECT * FROM company_settings LIMIT 1');
      const dashboard = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM invoices WHERE document_kind = 'standard') AS invoice_count,
          (SELECT COALESCE(SUM(total), 0) FROM fiscal_sales WHERE COALESCE(processing_status, 'completed') = 'completed' AND storno = false) AS fiscal_sales_total,
          (SELECT COALESCE(SUM(CASE WHEN unit = 'piece' THEN total_gram * price ELSE quantity * price END), 0) FROM stock_items WHERE quantity > 0) AS stock_value
      `);

      return {
        company: company.rows[0] || null,
        dashboard: dashboard.rows[0] || {},
      };
    },

    async get_sales_summary({ period = 'month' } = {}) {
      const fromDate = periodStart(normalizePeriod(period));
      const summary = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE storno = false)::int AS transactions,
          COALESCE(SUM(total) FILTER (WHERE storno = false), 0) AS revenue,
          COALESCE(AVG(total) FILTER (WHERE storno = false), 0) AS average_sale,
          COUNT(*) FILTER (WHERE storno = true)::int AS storno_count
        FROM fiscal_sales
        WHERE COALESCE(processing_status, 'completed') = 'completed'
          AND date >= $1
      `, [fromDate]);

      return {
        period: normalizePeriod(period),
        summary: summary.rows[0] || {},
      };
    },

    async get_stock_summary({ warehouse = 'magacin_1' } = {}) {
      const safeWarehouse = String(warehouse || 'magacin_1').slice(0, 64);
      const summary = await pool.query(`
        SELECT
          COUNT(*)::int AS item_count,
          COALESCE(SUM(CASE WHEN unit = 'gram' THEN quantity ELSE 0 END), 0) AS total_grams,
          COALESCE(SUM(CASE WHEN unit = 'piece' THEN quantity ELSE 0 END), 0) AS total_pieces,
          COALESCE(SUM(CASE WHEN unit = 'piece' THEN total_gram * price ELSE quantity * price END), 0) AS total_value
        FROM stock_items
        WHERE warehouse = $1
          AND quantity > 0
      `, [safeWarehouse]);

      const lowStock = await pool.query(`
        SELECT id, name, category, quantity, unit, price, total_gram
        FROM stock_items
        WHERE warehouse = $1
          AND quantity > 0
          AND ((unit = 'piece' AND quantity <= 5) OR (unit = 'gram' AND quantity <= 10))
        ORDER BY quantity ASC
        LIMIT 20
      `, [safeWarehouse]);

      return {
        warehouse: safeWarehouse,
        summary: summary.rows[0] || {},
        lowStock: lowStock.rows,
      };
    },

    async get_unpaid_invoices({ limit = 10 } = {}) {
      const safeLimit = clampLimit(limit, 10, 20);
      const result = await pool.query(`
        SELECT
          i.id,
          i.number,
          i.date,
          i.due_date,
          c.name AS client_name,
          COALESCE(NULLIF(i.total, 0), i.subtotal, 0) AS total,
          GREATEST(0, COALESCE(NULLIF(i.total, 0), i.subtotal, 0) - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0)) AS balance
        FROM invoices i
        LEFT JOIN clients c ON c.id = i.client_id
        WHERE i.type = 'out'
          AND i.document_kind = 'standard'
          AND GREATEST(0, COALESCE(NULLIF(i.total, 0), i.subtotal, 0) - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0)) > 0.01
        ORDER BY i.due_date NULLS LAST, i.date DESC
        LIMIT $1
      `, [safeLimit]);

      return { limit: safeLimit, invoices: result.rows };
    },
  };

  return createReadOnlyToolRegistry({
    tools: toolDefinitions.map((definition) => ({
      ...definition,
      handler: handlers[definition.name],
    })),
  });
};
