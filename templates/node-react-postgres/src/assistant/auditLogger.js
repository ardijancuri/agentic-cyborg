export const createProjectAuditLogger = ({ AuditLog = null } = {}) => {
  return async (event) => {
    if (!AuditLog?.safeCreate) {
      return;
    }

    await AuditLog.safeCreate({
      req: event.requestContext?.req,
      user: event.user,
      module: event.module,
      action: event.action,
      target_type: event.targetType,
      target_id: event.targetId,
      description: event.description,
      metadata: event.metadata || {},
    });
  };
};
