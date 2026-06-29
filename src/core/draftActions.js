import { resolveDraftActionRoute } from './pageRegistry.js';

const DEFAULT_DRAFT_TYPES = new Set([
  'open_page',
  'review_record',
  'review_invoice',
  'follow_up_client',
  'review_stock',
  'review_purchase',
  'review_report',
  'update_product_price',
  'operational_note',
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
