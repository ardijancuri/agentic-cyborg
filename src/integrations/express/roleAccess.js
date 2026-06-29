const defaultGetUser = (req) => req.user;

const userRoles = (user) => {
  if (!user) {
    return [];
  }

  const roles = [];

  if (user.role) {
    roles.push(user.role);
  }

  if (Array.isArray(user.roles)) {
    roles.push(...user.roles);
  }

  return roles.map((role) => String(role).trim()).filter(Boolean);
};

export const createAssistantRoleAuthorize = ({
  roles = ['admin', 'full_admin'],
  getUser = defaultGetUser,
  message = 'Assistant access denied',
} = {}) => {
  const allowed = new Set(roles.map((role) => String(role).trim()).filter(Boolean));

  return (req, res, next) => {
    const hasRole = userRoles(getUser(req)).some((role) => allowed.has(role));

    if (hasRole) {
      next();
      return;
    }

    res.status(403).json({ error: message });
  };
};
