import {
  calculateProductPrice,
  createActionPreviewFingerprint,
  createWriteActionRegistry,
  normalizeBulkLimit,
  normalizePriceMutation,
} from '@oninova/personal-software-assistant';

const priceColumns = new Map([
  ['price', 'price'],
  ['regular_price', 'price'],
  ['sale_price', 'sale_price'],
]);

const detailFields = new Map([
  ['name', 'name'],
  ['sku', 'sku'],
  ['description', 'description'],
  ['shortDescription', 'short_description'],
  ['status', 'status'],
  ['categoryId', 'category_id'],
]);

const inventoryFields = new Map([
  ['quantity', 'quantity'],
  ['reorderLevel', 'reorder_level'],
]);

const asNumber = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const actionError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const productId = (value) => {
  const id = String(value || '').trim();
  if (!id) throw actionError('Product id is required');
  return id;
};

const withTransaction = async (pool, callback) => {
  const client = await pool.connect?.();
  const db = client || pool;

  try {
    await db.query('BEGIN');
    const result = await callback(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client?.release?.();
  }
};

const loadProduct = async (db, id, { lock = false } = {}) => {
  const result = await db.query(
    `SELECT p.*, c.name AS category_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id::text = $1
     ${lock ? 'FOR UPDATE OF p' : ''}`,
    [productId(id)]
  );
  if (!result.rows[0]) throw actionError('Product not found', 404);
  return result.rows[0];
};

const categoryWhere = (payload = {}, startIndex = 1) => {
  if (payload.categoryId) {
    return { sql: `p.category_id::text = $${startIndex}`, values: [String(payload.categoryId)] };
  }
  if (payload.categoryName) {
    return {
      sql: `LOWER(c.name) = LOWER($${startIndex})`,
      values: [String(payload.categoryName)],
    };
  }
  throw actionError('Category id or category name is required');
};

const loadCategoryProducts = async (db, payload, maxItems, { lock = false } = {}) => {
  const where = categoryWhere(payload);
  const result = await db.query(
    `SELECT p.*, c.name AS category_name
     FROM products p
     JOIN categories c ON c.id = p.category_id
     WHERE ${where.sql}
     ORDER BY p.name ASC
     LIMIT $${where.values.length + 1}
     ${lock ? 'FOR UPDATE OF p' : ''}`,
    [...where.values, maxItems + 1]
  );
  if (result.rows.length > maxItems) {
    throw actionError(`Category contains more than the ${maxItems} product limit`);
  }
  if (!result.rows.length) throw actionError('No products found in this category', 404);
  return result.rows;
};

const normalizeDetailChanges = (fields = {}) => {
  const entries = Object.entries(fields || {});
  if (!entries.length) throw actionError('At least one product detail field is required');

  return entries.map(([field, value]) => {
    const column = detailFields.get(field);
    if (!column) throw actionError(`Unsupported product detail field: ${field}`);
    if (field === 'status' && !['active', 'draft', 'archived', 'publish', 'private'].includes(String(value))) {
      throw actionError('Unsupported product status');
    }
    return { field, column, value };
  });
};

const normalizeInventoryChanges = (fields = {}) => {
  const entries = Object.entries(fields || {});
  if (!entries.length) throw actionError('At least one inventory field is required');

  return entries.map(([field, value]) => {
    const column = inventoryFields.get(field);
    const numeric = asNumber(value);
    if (!column) throw actionError(`Unsupported inventory field: ${field}`);
    if (numeric === null || numeric < 0) throw actionError(`${field} must be a non-negative number`);
    return { field, column, value: numeric };
  });
};

const priceChange = (product, item = {}, defaults = {}) => {
  const requestedField = String(item.priceField || defaults.priceField || 'price');
  const column = priceColumns.get(requestedField);
  if (!column) throw actionError('Unsupported product price field');

  const mutation = normalizePriceMutation(
    { ...defaults, ...item, priceField: column },
    { ...defaults, priceField: column }
  );
  const currentPrice = asNumber(product[column]);
  if (item.currentPrice !== undefined && asNumber(item.currentPrice) !== currentPrice) {
    throw actionError('Product price changed since this action was drafted', 409);
  }

  const newPrice = calculateProductPrice({
    currentPrice,
    regularPrice: asNumber(product.price),
    mutation,
  });

  return {
    productId: String(product.id),
    name: product.name,
    sku: product.sku,
    priceField: column,
    operation: mutation.operation,
    oldPrice: currentPrice,
    newPrice,
  };
};

const previewFromChanges = (summary, changes, warnings = []) => ({
  summary,
  affectedCount: changes.length,
  items: changes.slice(0, 20).map(({ productId: id, name, sku }) => ({ id, name, sku })),
  changes: changes.slice(0, 20),
  warnings,
  fingerprint: createActionPreviewFingerprint(changes),
});

const explicitItems = (payload, maxItems) => {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length || items.length > maxItems) {
    throw actionError(`Bulk action must contain 1 to ${maxItems} products`);
  }
  const ids = items.map((item) => productId(item.productId || item.id));
  if (new Set(ids).size !== ids.length) throw actionError('Bulk action contains duplicate products');
  return items;
};

const previewPriceItems = async (db, items, defaults = {}) => {
  const changes = [];
  for (const item of items) {
    changes.push(priceChange(await loadProduct(db, item.productId || item.id), item, defaults));
  }
  return previewFromChanges('Review product price changes', changes);
};

const applyPriceItems = async (db, items, defaults = {}) => {
  const changes = [];
  for (const item of items) {
    const product = await loadProduct(db, item.productId || item.id, { lock: true });
    const change = priceChange(product, item, defaults);
    await db.query(
      `UPDATE products SET ${change.priceField} = $1, updated_at = NOW() WHERE id::text = $2`,
      [change.newPrice, change.productId]
    );
    changes.push(change);
  }
  return { updatedCount: changes.length, items: changes };
};

const detailChange = (product, fields, currentValues = {}) => {
  const changes = normalizeDetailChanges(fields);
  for (const { field, column } of changes) {
    if (Object.hasOwn(currentValues, field)
      && String(product[column] ?? '') !== String(currentValues[field] ?? '')) {
      throw actionError('Product details changed since this action was drafted', 409);
    }
  }
  return {
    productId: String(product.id),
    name: product.name,
    sku: product.sku,
    oldValues: Object.fromEntries(changes.map(({ field, column }) => [field, product[column]])),
    newValues: Object.fromEntries(changes.map(({ field, value }) => [field, value])),
    assignments: changes,
  };
};

const previewDetailItems = async (db, items, defaultFields = null) => {
  const changes = [];
  for (const item of items) {
    const product = await loadProduct(db, item.productId || item.id);
    changes.push(detailChange(product, item.fields || defaultFields, item.currentValues || {}));
  }
  return previewFromChanges('Review product detail changes', changes.map(({ assignments, ...change }) => change));
};

const applyDetailItems = async (db, items, defaultFields = null) => {
  const results = [];
  for (const item of items) {
    const product = await loadProduct(db, item.productId || item.id, { lock: true });
    const change = detailChange(product, item.fields || defaultFields, item.currentValues || {});
    const assignments = change.assignments.map(({ column }, index) => `${column} = $${index + 1}`);
    const values = change.assignments.map(({ value }) => value);
    await db.query(
      `UPDATE products SET ${assignments.join(', ')}, updated_at = NOW()
       WHERE id::text = $${values.length + 1}`,
      [...values, change.productId]
    );
    const { assignments: ignored, ...result } = change;
    results.push(result);
  }
  return { updatedCount: results.length, items: results };
};

const loadInventory = async (db, id, { lock = false } = {}) => {
  const result = await db.query(
    `SELECT i.*, p.name, p.sku
     FROM inventory_items i
     JOIN products p ON p.id = i.product_id
     WHERE i.product_id::text = $1
     ${lock ? 'FOR UPDATE OF i' : ''}`,
    [productId(id)]
  );
  if (!result.rows[0]) throw actionError('Product inventory record not found', 404);
  return result.rows[0];
};

const inventoryChange = (inventory, fields, currentValues = {}) => {
  const changes = normalizeInventoryChanges(fields);
  for (const { field, column } of changes) {
    if (Object.hasOwn(currentValues, field) && asNumber(inventory[column]) !== asNumber(currentValues[field])) {
      throw actionError('Product inventory changed since this action was drafted', 409);
    }
  }
  return {
    productId: String(inventory.product_id),
    name: inventory.name,
    sku: inventory.sku,
    oldValues: Object.fromEntries(changes.map(({ field, column }) => [field, asNumber(inventory[column])])),
    newValues: Object.fromEntries(changes.map(({ field, value }) => [field, value])),
    assignments: changes,
  };
};

const previewInventoryItems = async (db, items, defaultFields = null) => {
  const changes = [];
  for (const item of items) {
    const inventory = await loadInventory(db, item.productId || item.id);
    changes.push(inventoryChange(inventory, item.fields || defaultFields, item.currentValues || {}));
  }
  return previewFromChanges('Review product inventory changes', changes.map(({ assignments, ...change }) => change));
};

const applyInventoryItems = async (db, items, defaultFields = null) => {
  const results = [];
  for (const item of items) {
    const inventory = await loadInventory(db, item.productId || item.id, { lock: true });
    const change = inventoryChange(inventory, item.fields || defaultFields, item.currentValues || {});
    const assignments = change.assignments.map(({ column }, index) => `${column} = $${index + 1}`);
    const values = change.assignments.map(({ value }) => value);
    await db.query(
      `UPDATE inventory_items SET ${assignments.join(', ')}
       WHERE product_id::text = $${values.length + 1}`,
      [...values, change.productId]
    );
    const { assignments: ignored, ...result } = change;
    results.push(result);
  }
  return { updatedCount: results.length, items: results };
};

const categoryItems = (products, fields = null) => products.map((product) => ({
  productId: String(product.id),
  ...(fields ? { fields } : {}),
}));

const priceSchema = {
  type: 'object',
  properties: {
    priceField: { type: 'string', enum: ['price', 'regular_price', 'sale_price'] },
    operation: { type: 'string', enum: ['set', 'increase_percent', 'decrease_percent', 'increase_fixed', 'decrease_fixed', 'set_percent_of_regular_price', 'clear'] },
    newPrice: { type: 'number' },
    amount: { type: 'number' },
    percent: { type: 'number' },
  },
};

export const createProjectWriteActionRegistry = ({
  pool,
  maxBulkItems = 100,
  requiredRoles = ['full_admin'],
} = {}) => {
  if (!pool?.query) throw new Error('createProjectWriteActionRegistry requires a PostgreSQL pool/client');
  const categoryLimit = normalizeBulkLimit(maxBulkItems, 100, 500);

  return createWriteActionRegistry({
    actions: [
      {
        type: 'update_product_price',
        title: 'Update product price',
        description: 'Set, adjust, or clear one approved product regular/sale price.',
        resource: 'product', scope: 'single', risk: 'medium', maxBatchSize: 1,
        requiredRoles,
        payloadSchema: { ...priceSchema, required: ['productId', 'priceField', 'operation', 'reason'] },
        preview: ({ payload }) => previewPriceItems(pool, [payload]),
        apply: ({ payload }) => withTransaction(pool, (db) => applyPriceItems(db, [payload])),
      },
      {
        type: 'bulk_update_product_prices',
        title: 'Bulk update product prices',
        description: 'Set or adjust prices for an explicit bounded product selection.',
        resource: 'product', scope: 'selection', risk: 'high', maxBatchSize: 50,
        requiredRoles,
        payloadSchema: { type: 'object', required: ['items', 'reason'], properties: { ...priceSchema.properties, items: { type: 'array', minItems: 1, maxItems: 50 } } },
        preview: ({ payload }) => previewPriceItems(pool, explicitItems(payload, 50), payload),
        apply: ({ payload }) => withTransaction(pool, (db) => applyPriceItems(db, explicitItems(payload, 50), payload)),
      },
      {
        type: 'bulk_update_product_prices_by_category',
        title: 'Bulk update category product prices',
        description: 'Set, adjust, or clear prices for every product resolved from one category.',
        resource: 'product', scope: 'category', risk: 'high', maxBatchSize: categoryLimit,
        requiredRoles,
        payloadSchema: { type: 'object', required: ['priceField', 'operation', 'maxItems', 'reason'], properties: { categoryId: { type: 'string' }, categoryName: { type: 'string' }, ...priceSchema.properties, maxItems: { type: 'integer', minimum: 1, maximum: categoryLimit }, reason: { type: 'string' } } },
        preview: async ({ payload }) => {
          const limit = normalizeBulkLimit(payload.maxItems, categoryLimit, categoryLimit);
          const products = await loadCategoryProducts(pool, payload, limit);
          const changes = products.map((product) => priceChange(product, payload, payload));
          return previewFromChanges('Review category product price changes', changes);
        },
        apply: ({ payload }) => withTransaction(pool, async (db) => {
          const limit = normalizeBulkLimit(payload.maxItems, categoryLimit, categoryLimit);
          const products = await loadCategoryProducts(db, payload, limit, { lock: true });
          return applyPriceItems(db, categoryItems(products), payload);
        }),
      },
      {
        type: 'update_product_details',
        title: 'Update product details',
        description: 'Update approved product catalog fields.',
        resource: 'product', scope: 'single', risk: 'medium', maxBatchSize: 1,
        requiredRoles,
        payloadSchema: { type: 'object', required: ['productId', 'fields', 'reason'], properties: { productId: { type: 'string' }, fields: { type: 'object' }, currentValues: { type: 'object' }, reason: { type: 'string' } } },
        preview: ({ payload }) => previewDetailItems(pool, [payload]),
        apply: ({ payload }) => withTransaction(pool, (db) => applyDetailItems(db, [payload])),
      },
      {
        type: 'bulk_update_product_details',
        title: 'Bulk update product details',
        description: 'Update approved catalog fields for an explicit product selection.',
        resource: 'product', scope: 'selection', risk: 'high', maxBatchSize: 50,
        requiredRoles,
        payloadSchema: { type: 'object', required: ['items', 'reason'], properties: { items: { type: 'array', minItems: 1, maxItems: 50 }, reason: { type: 'string' } } },
        preview: ({ payload }) => previewDetailItems(pool, explicitItems(payload, 50)),
        apply: ({ payload }) => withTransaction(pool, (db) => applyDetailItems(db, explicitItems(payload, 50))),
      },
      {
        type: 'bulk_update_product_details_by_category',
        title: 'Bulk update category product details',
        description: 'Update approved catalog fields for products resolved from one category.',
        resource: 'product', scope: 'category', risk: 'high', maxBatchSize: categoryLimit,
        requiredRoles,
        payloadSchema: { type: 'object', required: ['fields', 'maxItems', 'reason'], properties: { categoryId: { type: 'string' }, categoryName: { type: 'string' }, fields: { type: 'object' }, maxItems: { type: 'integer', minimum: 1, maximum: categoryLimit }, reason: { type: 'string' } } },
        preview: async ({ payload }) => {
          const products = await loadCategoryProducts(pool, payload, normalizeBulkLimit(payload.maxItems, categoryLimit, categoryLimit));
          return previewDetailItems(pool, categoryItems(products, payload.fields));
        },
        apply: ({ payload }) => withTransaction(pool, async (db) => {
          const products = await loadCategoryProducts(db, payload, normalizeBulkLimit(payload.maxItems, categoryLimit, categoryLimit), { lock: true });
          return applyDetailItems(db, categoryItems(products, payload.fields));
        }),
      },
      {
        type: 'update_product_inventory',
        title: 'Update product inventory',
        description: 'Update one product quantity or reorder level with stale-value checks.',
        resource: 'inventory', scope: 'single', risk: 'high', maxBatchSize: 1,
        requiredRoles,
        payloadSchema: { type: 'object', required: ['productId', 'fields', 'reason'], properties: { productId: { type: 'string' }, fields: { type: 'object' }, currentValues: { type: 'object' }, reason: { type: 'string' } } },
        preview: ({ payload }) => previewInventoryItems(pool, [payload]),
        apply: ({ payload }) => withTransaction(pool, (db) => applyInventoryItems(db, [payload])),
      },
      {
        type: 'bulk_update_product_inventory',
        title: 'Bulk update product inventory',
        description: 'Update quantity or reorder level for an explicit product selection.',
        resource: 'inventory', scope: 'selection', risk: 'high', maxBatchSize: 50,
        requiredRoles,
        payloadSchema: { type: 'object', required: ['items', 'reason'], properties: { items: { type: 'array', minItems: 1, maxItems: 50 }, reason: { type: 'string' } } },
        preview: ({ payload }) => previewInventoryItems(pool, explicitItems(payload, 50)),
        apply: ({ payload }) => withTransaction(pool, (db) => applyInventoryItems(db, explicitItems(payload, 50))),
      },
      {
        type: 'bulk_update_product_inventory_by_category',
        title: 'Bulk update category product inventory',
        description: 'Update quantity or reorder level for products resolved from one category.',
        resource: 'inventory', scope: 'category', risk: 'high', maxBatchSize: categoryLimit,
        requiredRoles,
        payloadSchema: { type: 'object', required: ['fields', 'maxItems', 'reason'], properties: { categoryId: { type: 'string' }, categoryName: { type: 'string' }, fields: { type: 'object' }, maxItems: { type: 'integer', minimum: 1, maximum: categoryLimit }, reason: { type: 'string' } } },
        preview: async ({ payload }) => {
          const products = await loadCategoryProducts(pool, payload, normalizeBulkLimit(payload.maxItems, categoryLimit, categoryLimit));
          return previewInventoryItems(pool, categoryItems(products, payload.fields));
        },
        apply: ({ payload }) => withTransaction(pool, async (db) => {
          const products = await loadCategoryProducts(db, payload, normalizeBulkLimit(payload.maxItems, categoryLimit, categoryLimit), { lock: true });
          return applyInventoryItems(db, categoryItems(products, payload.fields));
        }),
      },
    ],
  });
};
