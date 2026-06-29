import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WooCommerceAssistantRunner } from '../../src/integrations/woocommerce/WooCommerceAssistantRunner.js';
import { verifyWooCommerceAssistantSignature } from '../../src/integrations/woocommerce/hmac.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const loadEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
};

loadEnvFile(path.join(__dirname, '.env.local'));
loadEnvFile(path.join(__dirname, '.env'));

const port = Number(process.env.PORT || 4545);
const siteId = process.env.WOO_ASSISTANT_SITE_ID;
const siteSecret = process.env.WOO_ASSISTANT_SITE_SECRET;

if (!siteId || !siteSecret) {
  console.error('Set WOO_ASSISTANT_SITE_ID and WOO_ASSISTANT_SITE_SECRET in templates/wordpress-woocommerce/.env.local before starting the service.');
  process.exit(1);
}

const siteSecrets = new Map([[siteId, siteSecret]]);
const runner = new WooCommerceAssistantRunner({
  getSiteSecret: async (requestedSiteId) => siteSecrets.get(requestedSiteId),
});

const readBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const sendJson = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/v1/woocommerce/run') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  try {
    const rawBody = await readBody(req);
    const requestSiteId = req.headers['x-oninova-assistant-site'];
    const secret = siteSecrets.get(requestSiteId);

    if (!verifyWooCommerceAssistantSignature({ body: rawBody, headers: req.headers, secret })) {
      sendJson(res, 401, { error: 'Invalid WooCommerce assistant signature' });
      return;
    }

    const payload = rawBody ? JSON.parse(rawBody) : {};
    const result = await runner.run(payload);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || 'Assistant service failed' });
  }
});

server.listen(port, () => {
  console.log(`WooCommerce assistant service running on http://localhost:${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
  console.log(`OpenAI key configured: ${process.env.OPENAI_API_KEY ? 'yes' : 'no'}`);
});
