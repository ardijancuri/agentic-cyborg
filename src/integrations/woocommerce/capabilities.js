export const WOO_COMMERCE_READ_TOOL_NAMES = Object.freeze([
  'get_store_overview',
  'get_sales_summary',
  'get_order_summary',
  'get_product_summary',
  'find_products',
  'get_product_categories',
  'find_products_by_category',
  'get_order_statistics',
  'get_product_performance',
  'compare_products',
  'compare_categories',
  'get_customer_order_preferences',
  'get_marketing_campaign_recommendations',
  'get_low_stock_products',
  'get_customer_summary',
  'get_coupon_summary',
  'get_refund_summary',
  'get_operational_alerts',
]);

export const WOO_COMMERCE_WRITE_ACTION_TYPES = Object.freeze([
  'update_woocommerce_product_price',
  'bulk_update_woocommerce_product_prices',
  'bulk_update_woocommerce_category_product_prices',
  'update_woocommerce_product_details',
  'bulk_update_woocommerce_product_details',
  'bulk_update_woocommerce_category_product_details',
  'update_woocommerce_product_inventory',
  'bulk_update_woocommerce_product_inventory',
  'bulk_update_woocommerce_category_product_inventory',
]);

const readTools = new Set(WOO_COMMERCE_READ_TOOL_NAMES);
const writeActions = new Set(WOO_COMMERCE_WRITE_ACTION_TYPES);

export const filterWooCommerceToolDefinitions = (definitions = []) => (
  (Array.isArray(definitions) ? definitions : [])
    .filter((tool) => tool?.type === 'function' && readTools.has(tool?.name))
    .map((tool) => ({
      type: 'function',
      name: tool.name,
      description: String(tool.description || '').slice(0, 500),
      parameters: tool.parameters && typeof tool.parameters === 'object'
        ? tool.parameters
        : { type: 'object', properties: {}, additionalProperties: false },
      ...(tool.strict === true ? { strict: true } : {}),
    }))
);

export const filterWooCommerceWriteActions = (definitions = []) => (
  (Array.isArray(definitions) ? definitions : [])
    .filter((action) => writeActions.has(action?.type))
    .map((action) => {
      const scope = String(action.type).includes('category')
        ? 'category'
        : (String(action.type).includes('bulk') ? 'selection' : 'single');
      const hardLimit = scope === 'category' ? 100 : (scope === 'selection' ? 50 : 1);
      return {
        ...action,
        mode: 'write',
        resource: String(action.type).includes('inventory') ? 'inventory' : 'product',
        scope,
        risk: scope === 'single' ? 'medium' : 'high',
        maxBatchSize: Math.min(Math.max(1, Number.parseInt(action.maxBatchSize, 10) || hardLimit), hardLimit),
        requiresReview: true,
        supportsPreview: true,
      };
    })
);
