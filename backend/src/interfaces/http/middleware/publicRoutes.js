"use strict";

/**
 * Whitelist of routes that do NOT require authentication.
 * Everything else under /api/* requires a valid session.
 */
const PUBLIC_ROUTES = [
  { method: "GET", path: "/api/health" },
  { method: "GET", path: "/api/ollama/health" },
  { method: "GET", path: "/api/debug/static" },
  // Auth endpoints (login flow itself must be public)
  { method: "GET", path: "/api/auth/cas/login" },
  { method: "GET", path: "/api/auth/cas/callback" },
  { method: "GET", path: "/api/auth/me" },
  { method: "GET", path: "/api/auth/logout" },
  { method: "POST", path: "/api/auth/dev-login" },
  { method: "POST", path: "/api/auth/dev-logout" },
  // Exercise read endpoints are public (students need to see exercises before logging in? No,
  // but keeping GET exercises public for now since the frontend loads them for all users)
  { method: "GET", path: "/api/ejercicios" },
  { method: "GET", pathPrefix: "/api/ejercicios/" },
];

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
