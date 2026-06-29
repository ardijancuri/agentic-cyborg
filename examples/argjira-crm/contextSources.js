const money = (value) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : '0.00';
};

const tableRows = (rows = [], columns = []) => {
  if (!rows.length) {
    return 'No rows available.';
  }

  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${columns.map((column) => String(row[column] ?? '')).join(' | ')} |`),
  ].join('\n');
};

export const createArgjiraContextSources = () => [
  async ({ toolRegistry }) => {
    const overview = await toolRegistry.execute('get_business_overview', {});
    const company = overview.data.company || {};
    const dashboard = overview.data.dashboard || {};

    return {
      scope: 'business_profile',
      title: 'Business Profile',
      content: [
        '# Business Profile',
        '',
        `Name: ${company.name || 'Unknown business'}`,
        `Tax/NIPT: ${company.nipt || company.tax_number || 'Not set'}`,
        `Address: ${company.address || 'Not set'}`,
        '',
        '## Current totals',
        `Invoices: ${dashboard.invoice_count || 0}`,
        `Fiscal sales total: ${money(dashboard.fiscal_sales_total)}`,
        `Stock value: ${money(dashboard.stock_value)}`,
      ].join('\n'),
      metadata: { adapter: 'argjira-crm', tool: 'get_business_overview' },
    };
  },
  async ({ toolRegistry }) => {
    const stock = await toolRegistry.execute('get_stock_summary', { warehouse: 'magacin_1' });

    return {
      scope: 'stock_magacin_1',
      title: 'Stock Snapshot - Magacin 1',
      content: [
        '# Stock Snapshot',
        '',
        `Warehouse: ${stock.data.warehouse}`,
        `Items: ${stock.data.summary.item_count || 0}`,
        `Total grams: ${stock.data.summary.total_grams || 0}`,
        `Total pieces: ${stock.data.summary.total_pieces || 0}`,
        `Total value: ${money(stock.data.summary.total_value)}`,
        '',
        '## Low stock',
        tableRows(stock.data.lowStock || [], ['name', 'category', 'quantity', 'unit']),
      ].join('\n'),
      metadata: { adapter: 'argjira-crm', tool: 'get_stock_summary' },
    };
  },
  async ({ toolRegistry }) => {
    const unpaid = await toolRegistry.execute('get_unpaid_invoices', { limit: 10 });

    return {
      scope: 'unpaid_invoices',
      title: 'Unpaid Invoices',
      content: [
        '# Unpaid Invoices',
        '',
        tableRows(unpaid.data.invoices || [], ['number', 'client_name', 'balance', 'due_date']),
      ].join('\n'),
      metadata: { adapter: 'argjira-crm', tool: 'get_unpaid_invoices' },
    };
  },
];
