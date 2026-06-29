import crypto from 'node:crypto';

const SIGNATURE_HEADER = 'x-oninova-assistant-signature';
const TIMESTAMP_HEADER = 'x-oninova-assistant-timestamp';
const SITE_HEADER = 'x-oninova-assistant-site';

const normalizeHeaderName = (name) => String(name || '').toLowerCase();

export const getHeaderValue = (headers = {}, name) => {
  const target = normalizeHeaderName(name);

  if (typeof headers.get === 'function') {
    return headers.get(name) || headers.get(target) || '';
  }

  const match = Object.entries(headers).find(([key]) => normalizeHeaderName(key) === target);
  return match ? String(match[1] || '') : '';
};

export const createWooCommerceAssistantSignature = ({
  body,
  siteId,
  secret,
  timestamp = Math.floor(Date.now() / 1000).toString(),
}) => {
  if (!siteId || !secret) {
    throw new Error('siteId and secret are required to sign WooCommerce assistant requests');
  }

  const rawBody = typeof body === 'string' ? body : JSON.stringify(body || {});
  const payload = `${timestamp}.${siteId}.${rawBody}`;
  const signature = crypto.createHmac('sha256', String(secret)).update(payload).digest('hex');

  return {
    signature,
    timestamp,
    headers: {
      [SITE_HEADER]: siteId,
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: signature,
    },
  };
};

export const verifyWooCommerceAssistantSignature = ({
  body,
  headers,
  secret,
  maxSkewSeconds = 300,
}) => {
  const siteId = getHeaderValue(headers, SITE_HEADER);
  const timestamp = getHeaderValue(headers, TIMESTAMP_HEADER);
  const suppliedSignature = getHeaderValue(headers, SIGNATURE_HEADER);

  if (!siteId || !timestamp || !suppliedSignature || !secret) {
    return false;
  }

  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - numericTimestamp) > maxSkewSeconds) {
    return false;
  }

  const { signature } = createWooCommerceAssistantSignature({
    body,
    siteId,
    secret,
    timestamp,
  });

  const expected = Buffer.from(signature, 'hex');
  const supplied = Buffer.from(String(suppliedSignature), 'hex');

  if (expected.length !== supplied.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, supplied);
};

export const WOO_ASSISTANT_SIGNATURE_HEADERS = {
  site: SITE_HEADER,
  timestamp: TIMESTAMP_HEADER,
  signature: SIGNATURE_HEADER,
};
