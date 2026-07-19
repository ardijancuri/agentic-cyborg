import crypto from 'node:crypto';

export const PRODUCT_PRICE_OPERATIONS = Object.freeze([
  'set',
  'increase_percent',
  'decrease_percent',
  'increase_fixed',
  'decrease_fixed',
  'set_percent_of_regular_price',
  'clear',
]);

const OPERATION_ALIASES = new Map([
  ['set_fixed', 'set'],
  ['clear_sale_price', 'clear'],
]);

const asNumber = (value) => {
  if (value === '' || value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const mutationError = (message) => {
  const error = new Error(message);
  error.status = 400;
  return error;
};

const roundMoney = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

export const normalizeBulkLimit = (value, fallback = 50, max = 100) => {
  const numeric = Number.parseInt(value, 10);
  return Math.max(1, Math.min(Number.isFinite(numeric) ? numeric : fallback, max));
};

export const normalizePriceMutation = (input = {}, defaults = {}) => {
  const requested = String(input.operation || defaults.operation || (input.newPrice !== undefined ? 'set' : '')).trim();
  const operation = OPERATION_ALIASES.get(requested) || requested;
  if (!PRODUCT_PRICE_OPERATIONS.includes(operation)) {
    throw mutationError('Unsupported product price operation');
  }

  const priceField = String(input.priceField || defaults.priceField || 'price').trim();
  const value = asNumber(input.value ?? input.amount ?? input.newPrice ?? defaults.value ?? defaults.newPrice);
  const percent = asNumber(input.percent ?? defaults.percent);

  if (operation === 'set' && (value === null || value <= 0)) {
    throw mutationError('A fixed product price must be greater than 0');
  }
  if (['increase_fixed', 'decrease_fixed'].includes(operation) && (value === null || value <= 0)) {
    throw mutationError('A fixed price adjustment must be greater than 0');
  }
  if (['increase_percent', 'decrease_percent', 'set_percent_of_regular_price'].includes(operation)
    && (percent === null || percent <= 0 || percent > 100)) {
    throw mutationError('A price percentage must be greater than 0 and no more than 100');
  }
  if (operation === 'clear' && !['sale_price', 'salePrice'].includes(priceField)) {
    throw mutationError('Only a sale price can be cleared');
  }

  return { priceField, operation, value, percent };
};

export const calculateProductPrice = ({
  currentPrice,
  regularPrice,
  mutation,
  decimals = 2,
} = {}) => {
  const current = asNumber(currentPrice);
  const regular = asNumber(regularPrice);
  let next;

  switch (mutation.operation) {
    case 'clear':
      return null;
    case 'set':
      next = mutation.value;
      break;
    case 'increase_percent':
      if (current === null) throw mutationError('Current price is required for a percentage increase');
      next = current * (1 + mutation.percent / 100);
      break;
    case 'decrease_percent':
      if (current === null) throw mutationError('Current price is required for a percentage decrease');
      next = current * (1 - mutation.percent / 100);
      break;
    case 'increase_fixed':
      if (current === null) throw mutationError('Current price is required for a fixed increase');
      next = current + mutation.value;
      break;
    case 'decrease_fixed':
      if (current === null) throw mutationError('Current price is required for a fixed decrease');
      next = current - mutation.value;
      break;
    case 'set_percent_of_regular_price':
      if (regular === null) throw mutationError('Regular price is required for this sale price operation');
      next = regular * (mutation.percent / 100);
      break;
    default:
      throw mutationError('Unsupported product price operation');
  }

  next = roundMoney(next, Math.max(0, Math.min(Number.parseInt(decimals, 10) || 2, 6)));
  if (!Number.isFinite(next) || next <= 0) {
    throw mutationError('Calculated product price must be greater than 0');
  }

  if (['sale_price', 'salePrice'].includes(mutation.priceField) && regular !== null && next > regular) {
    throw mutationError('Sale price cannot be greater than the regular price');
  }

  return next;
};

const stableValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
};

export const createActionPreviewFingerprint = (value) => crypto
  .createHash('sha256')
  .update(JSON.stringify(stableValue(value)))
  .digest('hex');
