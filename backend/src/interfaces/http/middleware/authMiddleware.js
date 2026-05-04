"use strict";

const { isPublicRoute } = require("./publicRoutes");
const { hasMinRole } = require("../../../infrastructure/auth/roles");

/**
 * Returns true when the request is a /api/export/* call carrying a
 * `?token=<EXPORT_TOKEN>` that matches the env var. Used so professors
 * can pull the CSV/JSON dump from a browser without going through the
 * CAS login (the export endpoints contain enrolled students' UPV logins
 * and conversations, so the token is the gating credential).
 *
 * Returns false if EXPORT_TOKEN is empty/unset → bypass disabled.
 */
function isExportTokenBypass(req) {
  const expected = process.env.EXPORT_TOKEN;
  if (!expected) return false;
  const supplied = req.query && req.query.token;
  if (!supplied || supplied !== expected) return false;
  // app.use("/api", globalAuth) strips the mount prefix from req.path,
  // so we accept both "/export/..." (mounted) and "/api/export/..."
  // (defense in depth in case it's ever mounted directly on app).
  const p = req.path || "";
  return p.startsWith("/export/") || p.startsWith("/api/export/");
}

/**
 * Global authentication middleware.
 * Applied to ALL /api/* routes BEFORE any route handlers.
 *
 * - Whitelisted public routes pass through without a session.
 * - /api/export/* with a valid ?token=EXPORT_TOKEN pass through with
 *   a synthetic profesor identity (so requireRole still passes).
 * - All other routes require a valid session.
 * - On success, sets req.userId and req.userRole for downstream handlers.
 */
function globalAuth(req, res, next) {
  // Check if this route is in the public whitelist
  if (isPublicRoute(req.method, req.path)) {
    return next();
  }

  // Token-bypass for the data-export endpoints.
  if (isExportTokenBypass(req)) {
    req.userId = "export-token";
    req.userRole = "profesor";
    return next();
  }

  // Require valid session
  if (!req.session?.user?.id) {
    return res.status(401).json({ error: "No autenticado" });
  }

  // Set convenience properties derived from session (NEVER from client)
  req.userId = req.session.user.id;
  req.userRole = req.session.user.rol || "alumno";

  next();
}

/**
 * Role-based access control middleware factory.
 * Restricts access to users with one of the specified roles.
 *
 * Usage: router.delete("/:id", requireRole("profesor", "admin"), handler)
 *
 * @param {...string} roles - Allowed roles
 */
function requireRole(...roles) {
  return function (req, res, next) {
    const userRole = req.userRole || req.session?.user?.rol || "alumno";
    if (!roles.includes(userRole)) {
      return res
        .status(403)
        .json({ error: "No tienes permisos para esta acción" });
    }
    next();
  };
}

/**
 * Ownership check: verify the authenticated user owns the resource,
 * OR has a role that allows viewing other users' data (profesor, admin).
 *
 * @param {string} resourceUserId - The userId that owns the resource
 * @param {object} req - Express request (with req.userId and req.userRole)
 * @returns {boolean}
 */
function canAccessUserData(resourceUserId, req) {
  if (String(resourceUserId) === String(req.userId)) return true;
  return hasMinRole(req.userRole, "profesor");
}

module.exports = { globalAuth, requireRole, canAccessUserData };
