const money = (value) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : '0.00';
};

const tableRows = (rows = [], columns = []) => {
  if (!rows.length) {
    return 'No rows available.';
  }

  return [
    `| ${columns.join(' |')} |`,
    `| ${columns.map(() => '---').join(' |')} |`,
    ...rows.map((row) => `| ${columns.map((column) => String(row[column] ?? '')).join(' |')} |`),
  ].join('\n');
};

export const createProjectContextSources = () => [
  async ({ toolRegistry }) => {
    const overview = await toolRegistry.execute('get_business_overview', {});

    return {
      scope: 'business_profile',
      title: 'Business Profile',
      content: [
        '# Business Profile',
        '',
        `Orders: ${overview.data.orders || 0}`,
        `Revenue: ${money(overview.data.revenue)}`,
        `Inventory value: ${money(overview.data.inventoryValue)}`,
      ].join('\n'),
      metadata: { adapter: 'node-react-postgres', tool: 'get_business_overview' },
    };
  },
  async ({ toolRegistry }) => {
    const inventory = await toolRegistry.execute('get_inventory_summary', { limit: 10 });

    return {
      scope: 'inventory_snapshot',
      title: 'Inventory Snapshot',
      content: [
        '# Inventory Snapshot',
        '',
        `Products: ${inventory.data.productCount || 0}`,
        `Low stock items: ${(inventory.data.lowStock || []).length}`,
        '',
        '## Low stock',
        tableRows(inventory.data.lowStock || [], ['name', 'sku', 'quantity']),
      ].join('\n'),
      metadata: { adapter: 'node-react-postgres', tool: 'get_inventory_summary' },
    };
  },
  async ({ toolRegistry }) => {
    const invoices = await toolRegistry.execute('get_unpaid_invoices', { limit: 10 });

    return {
      scope: 'unpaid_invoices',
      title: 'Unpaid Invoices',
      content: [
        '# Unpaid Invoices',
        '',
        tableRows(invoices.data.invoices || [], ['number', 'customer_name', 'balance', 'due_date']),
      ].join('\n'),
      metadata: { adapter: 'node-react-postgres', tool: 'get_unpaid_invoices' },
    };
  },
];
