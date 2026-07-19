import { resolveDraftActionRoute } from './pageRegistry.js';

export const ADVISORY_DRAFT_ACTION_TYPES = Object.freeze([
  'open_page',
  'review_record',
  'review_invoice',
  'follow_up_client',
  'review_stock',
  'review_purchase',
  'review_report',
  'review_product',
  'review_inventory',
  'review_order',
  'review_customer',
  'review_coupon',
  'operational_note',
]);

const LEGACY_WRITE_DRAFT_ACTION_TYPES = [
  'update_product_price',
  'bulk_update_product_prices',
  'bulk_update_product_prices_by_category',
  'update_product_details',
  'bulk_update_product_details',
  'bulk_update_product_details_by_category',
  'update_woocommerce_product_price',
  'bulk_update_woocommerce_product_prices',
  'bulk_update_woocommerce_category_product_prices',
  'update_woocommerce_product_details',
  'bulk_update_woocommerce_product_details',
  'bulk_update_woocommerce_category_product_details',
];

const DEFAULT_DRAFT_TYPES = new Set([
  ...ADVISORY_DRAFT_ACTION_TYPES,
  ...LEGACY_WRITE_DRAFT_ACTION_TYPES,
]);

const asString = (value, fallback = '') => {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value === null || value === undefined) {
    return fallback;
  }

  return String(value).trim();
};

const normalizeConfidence = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(1, numeric));
};

const normalizePayload = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }

  return payload;
};

export const normalizeDraftAction = (action = {}, options = {}) => {
  const allowedTypes = options.allowedTypes
    ? new Set(options.allowedTypes)
    : DEFAULT_DRAFT_TYPES;
  const fallbackRoute = options.fallbackRoute || '/';

  const type = asString(action.type, 'operational_note');
  const title = asString(action.title);
  const reason = asString(action.reason);
  const routeResolution = resolveDraftActionRoute(action, {
    pageRegistry: options.pageRegistry,
    fallbackRoute,
  });

  if (!title || !reason) {
    return null;
  }

  return {
    type: allowedTypes.has(type) ? type : 'operational_note',
    title: title.slice(0, 255),
    reason: reason.slice(0, 2000),
    targetRoute: routeResolution.route || fallbackRoute,
    payload: normalizePayload(action.payload),
    confidence: normalizeConfidence(action.confidence),
    requiresUserReview: true,
    status: 'draft',
  };
};

export const validateDraftActions = (actions = [], options = {}) => {
  if (!Array.isArray(actions)) {
    return [];
  }

  const maxActions = Math.max(1, Math.min(parseInt(options.maxActions, 10) || 6, 12));

  return actions
    .slice(0, maxActions)
    .map((action) => normalizeDraftAction(action, options))
    .filter(Boolean);
};
