"use strict";

const { isPublicRoute } = require("./publicRoutes");
const { hasMinRole } = require("../../../infrastructure/auth/roles");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                    AUTH MIDDLEWARE                    |
            |  Authentication & authorization middleware module for |
            |  the /api/* surface: a global session gate, a role    |
            |  guard factory, and an ownership check. Session data  |
            |  is the only source of identity (never the client).   |
        ____|_______________________                                |
   Obj -> | isExportTokenBypass() | -> T/F           (reads env/req) |
          -------------------------                                  |
        ____|_________________                                       |
   Obj, Obj, Fn -> | globalAuth() | -> void          (sets req.user*) |
                  --------------                                     |
        ____|________________                                        |
   ...Txt -> | requireRole() | -> Fn               (factory)         |
            ---------------                                          |
        ____|_____________________                                   |
   Txt, Obj -> | canAccessUserData() | -> T/F        (reads req)      |
              ---------------------                                  |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
 Obj -> ____|_______________________
       | isExportTokenBypass() | -> T/F    (reads process.env and req (Obj))
        -------------------------
    True when the request is a /api/export/* call carrying a
    ?token=<EXPORT_TOKEN> that matches the env var, letting professors
    pull the dump without CAS login. False when EXPORT_TOKEN is unset.
*/
function isExportTokenBypass(req) {
  const expected = process.env.EXPORT_TOKEN;
  if (!expected) return false;
  const supplied = req.query && req.query.token;
  if (!supplied || supplied !== expected) return false;
  const p = req.path || "";
  return p.startsWith("/export/") || p.startsWith("/api/export/");
}

/*
 Obj, Obj, Fn -> ____|_________________
                | globalAuth() | -> void    (sets req.userId (Txt), req.userRole (Txt))
                 --------------
    Global auth middleware applied to ALL /api/* routes before handlers.
    Public whitelist and export-token requests pass through; every other
    route requires a valid session or returns 401.
*/
function globalAuth(req, res, next) {
  if (isPublicRoute(req.method, req.path)) {
    return next();
  }

  if (isExportTokenBypass(req)) {
    req.userId = "export-token";
    req.userRole = "profesor";
    return next();
  }

  if (!req.session?.user?.id) {
    return res.status(401).json({ error: "No autenticado" });
  }

  req.userId = req.session.user.id;
  req.userRole = req.session.user.rol || "alumno";

  next();
}

/*
 ...Txt -> ____|________________
          | requireRole() | -> Fn    (factory returning (req, res, next) -> void)
           ---------------
    Role-based access control factory. Returns a middleware that allows
    the request only when the session role is one of the given roles,
    otherwise responds 403.
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

/*
 Txt, Obj -> ____|_____________________
            | canAccessUserData() | -> T/F    (reads req.userId (Txt), req.userRole (Txt))
             ---------------------
    Ownership check: true when the authenticated user owns the resource,
    or holds a role (profesor, admin) allowed to view other users' data.
*/
function canAccessUserData(resourceUserId, req) {
  if (String(resourceUserId) === String(req.userId)) return true;
  return hasMinRole(req.userRole, "profesor");
}

module.exports = { globalAuth, requireRole, canAccessUserData };
