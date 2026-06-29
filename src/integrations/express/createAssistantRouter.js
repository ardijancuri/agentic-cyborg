const defaultGetLocale = (req) => req.headers['x-app-language'] || req.body?.locale || req.query?.locale || 'en';
const defaultGetUser = (req) => req.user;

const wrapAsync = (handler) => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (error) {
    next(error);
  }
};

export const createAssistantRouter = ({
  express,
  service,
  authenticate,
  authorize,
  getUser = defaultGetUser,
  getLocale = defaultGetLocale,
  getRequestContext = (req) => ({ req }),
}) => {
  if (!express?.Router) {
    throw new Error('createAssistantRouter requires the express module');
  }

  if (!service) {
    throw new Error('createAssistantRouter requires an AssistantService instance');
  }

  const router = express.Router();

  if (authenticate) {
    router.use(authenticate);
  }

  if (authorize) {
    router.use(authorize);
  }

  router.post('/chat', wrapAsync(async (req, res) => {
    const result = await service.chat({
      user: getUser(req),
      message: req.body?.message,
      conversationId: req.body?.conversationId || null,
      locale: getLocale(req),
      requestContext: getRequestContext(req),
    });

    res.json(result);
  }));

  router.get('/conversations', wrapAsync(async (req, res) => {
    res.json({ conversations: await service.listConversations(getUser(req)) });
  }));

  router.get('/conversations/:id', wrapAsync(async (req, res) => {
    res.json(await service.getConversation(req.params.id, getUser(req)));
  }));

  router.get('/context', wrapAsync(async (req, res) => {
    res.json(await service.listContext());
  }));

  router.post('/context/refresh', wrapAsync(async (req, res) => {
    res.json(await service.refreshContext(getUser(req), getRequestContext(req)));
  }));

  return router;
};
