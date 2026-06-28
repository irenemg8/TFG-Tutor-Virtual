"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                     PUBLIC ROUTES                     |
            |  Whitelist module declaring which /api/* routes may be |
            |  reached WITHOUT an authenticated session (health,    |
            |  CAS login flow, dev-login, exercise reads). Every    |
            |  other route requires a valid session via globalAuth. |
        ____|________________                                       |
   Txt, Txt -> | isPublicRoute() | -> T/F          (reads whitelist) |
              -----------------                                     |
            |                                                       |
            |   PUBLIC_ROUTES: [Obj]   (exported whitelist table)   |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
const PUBLIC_ROUTES = [
  { method: "GET", path: "/api/health" },
  { method: "GET", path: "/api/ollama/health" },
  { method: "GET", path: "/api/debug/static" },
  { method: "GET", path: "/api/auth/cas/login" },
  { method: "GET", path: "/api/auth/cas/callback" },
  { method: "GET", path: "/api/auth/me" },
  { method: "GET", path: "/api/auth/logout" },
  { method: "POST", path: "/api/auth/dev-login" },
  { method: "POST", path: "/api/auth/dev-logout" },
  { method: "GET", path: "/api/ejercicios" },
  { method: "GET", pathPrefix: "/api/ejercicios/" },
];

/*
 Txt, Txt -> ____|________________
            | isPublicRoute() | -> T/F    (reads PUBLIC_ROUTES ([Obj]))
             -----------------
    True when the given HTTP method + path matches a whitelist entry,
    either by exact path or by pathPrefix.
*/
function isPublicRoute(method, path) {
  return PUBLIC_ROUTES.some((route) => {
    const methodMatch = !route.method || route.method === method;
    if (route.pathPrefix) {
      return methodMatch && path.startsWith(route.pathPrefix);
    }
    return methodMatch && route.path === path;
  });
}

module.exports = { PUBLIC_ROUTES, isPublicRoute };
