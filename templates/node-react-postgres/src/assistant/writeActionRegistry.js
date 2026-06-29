import { createWriteActionRegistry } from '@oninova/personal-software-assistant';

const priceFields = new Set(['price', 'sale_price']);
const detailFields = new Map([
  ['name', 'name'],
  ['sku', 'sku'],
  ['description', 'description'],
  ['shortDescription', 'short_description'],
  ['status', 'status'],
  ['categoryId', 'category_id'],
]);

const asNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizePriceField = (value) => {
  const field = String(value || 'price').trim();
  if (!priceFields.has(field)) {
    const error = new Error('Unsupported product price field');
    error.status = 400;
    throw error;
  }
  return field;
};

const normalizeProductId = (value) => {
  const id = String(value || '').trim();
  if (!id) {
    const error = new Error('Product id is required');
    error.status = 400;
    throw error;
  }
  return id;
};

const normalizeDetailFields = (fields = {}) => {
  const entries = Object.entries(fields || {});
  if (!entries.length) {
    const error = new Error('At least one product detail field is required');
    error.status = 400;
    throw error;
  }

  return entries.map(([field, value]) => {
    const column = detailFields.get(field);
    if (!column) {
      const error = new Error(`Unsupported product detail field: ${field}`);
      error.status = 400;
      throw error;
    }
    return { field, column, value };
  });
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

const loadProductForUpdate = async (db, productId) => {
  const result = await db.query('SELECT * FROM products WHERE id::text = $1 FOR UPDATE', [productId]);
  const product = result.rows[0];
  if (!product) {
    const error = new Error('Product not found');
    error.status = 404;
    throw error;
  }
  return product;
};

const ensureCurrentPrice = (product, priceField, expectedPrice) => {
  if (expectedPrice === undefined || expectedPrice === null) {
    return;
  }
  const current = asNumber(product[priceField]);
  const expected = asNumber(expectedPrice);
  if (current === null || expected === null || Math.abs(current - expected) > 0.00001) {
    const error = new Error('Product price changed since this action was drafted');
    error.status = 409;
    throw error;
  }
};

const updateOnePrice = async (db, item = {}) => {
  const productId = normalizeProductId(item.productId || item.stockItemId || item.id);
  const priceField = normalizePriceField(item.priceField);
  const newPrice = asNumber(item.newPrice);
  if (newPrice === null || newPrice < 0) {
    const error = new Error('New price must be a non-negative number');
    error.status = 400;
    throw error;
  }

  const product = await loadProductForUpdate(db, productId);
  ensureCurrentPrice(product, priceField, item.currentPrice);

  await db.query(`UPDATE products SET ${priceField} = $1, updated_at = NOW() WHERE id::text = $2`, [newPrice, productId]);
  return {
    productId,
    priceField,
    oldPrice: product[priceField],
    newPrice,
  };
};

const updateOneDetails = async (db, item = {}) => {
  const productId = normalizeProductId(item.productId || item.stockItemId || item.id);
  const fields = normalizeDetailFields(item.fields);
  const product = await loadProductForUpdate(db, productId);
  const currentValues = item.currentValues || {};

  for (const { field, column } of fields) {
    if (Object.hasOwn(currentValues, field) && String(product[column] ?? '') !== String(currentValues[field] ?? '')) {
      const error = new Error('Product details changed since this action was drafted');
      error.status = 409;
      throw error;
    }
  }

  const assignments = fields.map(({ column }, index) => `${column} = $${index + 1}`);
  const values = fields.map(({ value }) => value);
  await db.query(
    `UPDATE products SET ${assignments.join(', ')}, updated_at = NOW() WHERE id::text = $${values.length + 1}`,
    [...values, productId]
  );

  return {
    productId,
    oldValues: Object.fromEntries(fields.map(({ field, column }) => [field, product[column]])),
    newValues: Object.fromEntries(fields.map(({ field, value }) => [field, value])),
  };
};

const categoryWhere = (payload = {}, startIndex = 1) => {
  if (payload.categoryId) {
    return { sql: `p.category_id::text = $${startIndex}`, values: [String(payload.categoryId)] };
  }
  if (payload.categoryName) {
    return {
      sql: `p.category_id IN (SELECT id FROM categories WHERE name = $${startIndex})`,
      values: [String(payload.categoryName)],
    };
  }

  const error = new Error('Category id or category name is required');
  error.status = 400;
  throw error;
};

const loadCategoryProductIds = async (db, payload = {}) => {
  const maxItems = Math.max(1, Math.min(Number.parseInt(payload.maxItems, 10) || 100, 100));
  const where = categoryWhere(payload, 1);
  const result = await db.query(
    `SELECT p.id::text AS id FROM products p WHERE ${where.sql} ORDER BY p.name ASC LIMIT $${where.values.length + 1}`,
    [...where.values, maxItems + 1]
  );

  if (result.rows.length > maxItems) {
    const error = new Error('Category product count exceeds the allowed bulk update limit');
    error.status = 400;
    throw error;
  }

  return result.rows.map((row) => row.id);
};

export const createProjectWriteActionRegistry = ({ pool }) => {
  if (!pool?.query) {
    throw new Error('createProjectWriteActionRegistry requires a PostgreSQL pool/client');
  }

  return createWriteActionRegistry({
    actions: [
      {
        type: 'update_product_price',
        handlerName: 'update_product_price',
        description: 'Update one approved product price field after full_admin approval.',
        requiredRoles: ['full_admin'],
        payloadSchema: { type: 'object', required: ['productId', 'newPrice'] },
        apply: async ({ action }) => withTransaction(pool, async (db) => updateOnePrice(db, action.payload)),
      },
      {
        type: 'bulk_update_product_prices',
        handlerName: 'bulk_update_product_prices',
        description: 'Update approved price fields for an explicit list of products after full_admin approval.',
        requiredRoles: ['full_admin'],
        payloadSchema: { type: 'object', required: ['items'] },
        apply: async ({ action }) => withTransaction(pool, async (db) => {
          const items = Array.isArray(action.payload?.items) ? action.payload.items : [];
          if (!items.length || items.length > 50) {
            const error = new Error('Bulk price actions must contain 1 to 50 products');
            error.status = 400;
            throw error;
          }
          const results = [];
          for (const item of items) {
            results.push(await updateOnePrice(db, item));
          }
          return { updatedCount: results.length, items: results };
        }),
      },
      {
        type: 'bulk_update_product_prices_by_category',
        handlerName: 'bulk_update_product_prices_by_category',
        description: 'Update one approved price field for all products in one resolved category after full_admin approval. This category action does not require every product id to be listed.',
        requiredRoles: ['full_admin'],
        payloadSchema: {
          type: 'object',
          required: ['priceField', 'newPrice', 'maxItems'],
          properties: {
            categoryId: { type: 'string' },
            categoryName: { type: 'string' },
            priceField: { type: 'string', enum: ['price', 'sale_price'] },
            newPrice: { type: 'number' },
            maxItems: { type: 'integer', minimum: 1, maximum: 100 },
            reason: { type: 'string' },
          },
          anyOf: [
            { required: ['categoryId'] },
            { required: ['categoryName'] },
          ],
        },
        apply: async ({ action }) => withTransaction(pool, async (db) => {
          const productIds = await loadCategoryProductIds(db, action.payload);
          const items = productIds.map((productId) => ({
            productId,
            priceField: action.payload.priceField,
            newPrice: action.payload.newPrice,
          }));
          const results = [];
          for (const item of items) {
            results.push(await updateOnePrice(db, item));
          }
          return { updatedCount: results.length, items: results };
        }),
      },
      {
        type: 'update_product_details',
        handlerName: 'update_product_details',
        description: 'Update approved product detail fields after full_admin approval.',
        requiredRoles: ['full_admin'],
        payloadSchema: { type: 'object', required: ['productId', 'fields'] },
        apply: async ({ action }) => withTransaction(pool, async (db) => updateOneDetails(db, action.payload)),
      },
      {
        type: 'bulk_update_product_details',
        handlerName: 'bulk_update_product_details',
        description: 'Update approved product detail fields for an explicit list of products after full_admin approval.',
        requiredRoles: ['full_admin'],
        payloadSchema: { type: 'object', required: ['items'] },
        apply: async ({ action }) => withTransaction(pool, async (db) => {
          const items = Array.isArray(action.payload?.items) ? action.payload.items : [];
          if (!items.length || items.length > 50) {
            const error = new Error('Bulk detail actions must contain 1 to 50 products');
            error.status = 400;
            throw error;
          }
          const results = [];
          for (const item of items) {
            results.push(await updateOneDetails(db, item));
          }
          return { updatedCount: results.length, items: results };
        }),
      },
      {
        type: 'bulk_update_product_details_by_category',
        handlerName: 'bulk_update_product_details_by_category',
        description: 'Update approved product detail fields for all products in one resolved category after full_admin approval. This category action does not require every product id to be listed.',
        requiredRoles: ['full_admin'],
        payloadSchema: {
          type: 'object',
          required: ['fields', 'maxItems'],
          properties: {
            categoryId: { type: 'string' },
            categoryName: { type: 'string' },
            fields: { type: 'object', additionalProperties: true },
            maxItems: { type: 'integer', minimum: 1, maximum: 100 },
            reason: { type: 'string' },
          },
          anyOf: [
            { required: ['categoryId'] },
            { required: ['categoryName'] },
          ],
        },
        apply: async ({ action }) => withTransaction(pool, async (db) => {
          const productIds = await loadCategoryProductIds(db, action.payload);
          const results = [];
          for (const productId of productIds) {
            results.push(await updateOneDetails(db, { productId, fields: action.payload.fields }));
          }
          return { updatedCount: results.length, items: results };
        }),
      },
    ],
  });
};
