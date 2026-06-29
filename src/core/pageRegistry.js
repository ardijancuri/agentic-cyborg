const DEFAULT_FALLBACK_ROUTE = '/';

const asString = (value, fallback = '') => {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value === null || value === undefined) {
    return fallback;
  }

  return String(value).trim();
};

const normalizeLookupValue = (value) => {
  return asString(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
};

const normalizeKey = (value, fallback = '') => {
  return normalizeLookupValue(value || fallback)
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

const normalizeRoute = (value) => {
  const route = asString(value).split(/[?#]/)[0];
  if (!route.startsWith('/')) {
    return '';
  }

  return route.length > 1 ? route.replace(/\/+$/g, '') : route;
};

const unique = (values) => [...new Set(values.filter(Boolean))];

const toPageArray = (pages) => {
  if (Array.isArray(pages)) {
    return pages;
  }

  if (!pages || typeof pages !== 'object') {
    return [];
  }

  return Object.entries(pages).map(([id, page]) => {
    if (typeof page === 'string') {
      return { id, route: page };
    }

    return { id, ...(page || {}) };
  });
};

export const normalizePageRegistry = (pages = []) => {
  return toPageArray(pages)
    .map((page) => {
      const route = normalizeRoute(page.route || page.path || page.targetRoute);
      if (!route) {
        return null;
      }

      const id = normalizeKey(page.id || page.key || page.name || page.label || route, route);
      const label = asString(page.label || page.title || page.name || id);
      const legacyRoutes = unique((page.legacyRoutes || page.redirects || []).map(normalizeRoute));
      const aliases = unique([
        id,
        label,
        route,
        ...legacyRoutes,
        ...(page.aliases || []),
      ].map(normalizeLookupValue));

      return {
        id,
        label,
        route,
        description: asString(page.description),
        aliases,
        legacyRoutes,
        actionTypes: unique((page.actionTypes || []).map(normalizeLookupValue)),
        keywords: unique((page.keywords || []).map(normalizeLookupValue)),
      };
    })
    .filter(Boolean);
};

export const formatPageRegistryForPrompt = (pages = [], options = {}) => {
  const fallbackRoute = normalizeRoute(options.fallbackRoute) || DEFAULT_FALLBACK_ROUTE;
  const registry = normalizePageRegistry(pages);

  if (registry.length === 0) {
    return `- fallback -> ${fallbackRoute}`;
  }

  return registry
    .map((page) => {
      const details = [
        page.description,
        page.actionTypes.length > 0 ? `action types: ${page.actionTypes.join(', ')}` : '',
      ].filter(Boolean).join('; ');

      return `- ${page.id}: ${page.label} -> ${page.route}${details ? ` (${details})` : ''}`;
    })
    .join('\n');
};

const findPageByRoute = (registry, route) => {
  return registry.find((page) => page.route === route || page.legacyRoutes.includes(route));
};

const findPageByAlias = (registry, value) => {
  const normalized = normalizeLookupValue(value);
  if (!normalized) {
    return null;
  }

  return registry.find((page) => page.aliases.includes(normalized));
};

const findPageByActionType = (registry, type) => {
  const normalizedType = normalizeLookupValue(type);
  if (!normalizedType) {
    return null;
  }

  return registry.find((page) => page.actionTypes.includes(normalizedType));
};

const actionPayload = (action) => {
  if (!action?.payload || typeof action.payload !== 'object' || Array.isArray(action.payload)) {
    return {};
  }

  return action.payload;
};

const collectDirectTargets = (action) => {
  const payload = actionPayload(action);

  return [
    action?.targetRoute,
    action?.target_route,
    action?.targetPage,
    action?.target_page,
    action?.pageId,
    action?.page_id,
    payload.targetRoute,
    payload.target_route,
    payload.targetPage,
    payload.target_page,
    payload.pageId,
    payload.page_id,
    payload.page,
    payload.route,
    payload.module,
    payload.scope,
    payload.area,
  ].map(asString).filter(Boolean);
};

const scorePage = (page, action) => {
  const payload = actionPayload(action);
  const haystack = normalizeLookupValue([
    action?.type,
    action?.title,
    action?.reason,
    payload.type,
    payload.module,
    payload.scope,
    payload.area,
    payload.entity,
  ].filter(Boolean).join(' '));

  let score = 0;

  if (page.actionTypes.includes(normalizeLookupValue(action?.type))) {
    score += 8;
  }

  for (const keyword of page.keywords) {
    if (keyword && haystack.includes(keyword)) {
      score += 3;
    }
  }

  for (const alias of page.aliases) {
    if (alias && alias !== page.route && haystack.includes(alias)) {
      score += 1;
    }
  }

  return score;
};

export const resolveDraftActionRoute = (action = {}, options = {}) => {
  const fallbackRoute = normalizeRoute(options.fallbackRoute) || DEFAULT_FALLBACK_ROUTE;
  const registry = normalizePageRegistry(options.pageRegistry || options.pages || []);

  if (registry.length === 0) {
    return {
      route: normalizeRoute(action.targetRoute || action.target_route) || fallbackRoute,
      page: null,
      reason: 'no_registry',
    };
  }

  for (const target of collectDirectTargets(action)) {
    const route = normalizeRoute(target);
    const page = route ? findPageByRoute(registry, route) : findPageByAlias(registry, target);
    if (page) {
      return { route: page.route, page, reason: 'direct_match' };
    }
  }

  const actionPage = findPageByActionType(registry, action.type);
  if (actionPage) {
    return { route: actionPage.route, page: actionPage, reason: 'action_type' };
  }

  const scored = registry
    .map((page) => ({ page, score: scorePage(page, action) }))
    .sort((a, b) => b.score - a.score);

  if (scored[0]?.score > 0) {
    return { route: scored[0].page.route, page: scored[0].page, reason: 'keyword_match' };
  }

  const fallbackPage = findPageByRoute(registry, fallbackRoute) || registry[0];
  return {
    route: fallbackPage?.route || fallbackRoute,
    page: fallbackPage || null,
    reason: 'fallback',
  };
};
