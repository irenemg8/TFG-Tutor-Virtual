"use strict";

const { globalAuth } = require("../../src/interfaces/http/middleware/authMiddleware");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |               EXPORT_TOKEN AUTH BYPASS                |
            |  Test suite for globalAuth's EXPORT_TOKEN bypass.     |
            |  Verifies that /export routes accept a matching       |
            |  ?token= only when EXPORT_TOKEN is set, reject        |
            |  unset/wrong tokens (401), never bypass non-export    |
            |  routes, and leave normal session login intact.       |
        ____|____________                                           |
   void -> | makeRes() | -> Obj                                     |
           -----------                                              |
        ____|_________                                              |
   Obj -> | call() | -> Obj                                         |
          ----------                                                |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
     void -> ____|____________
            | makeRes() | -> Obj
             -----------
        Builds a minimal fake Express response that records the status code
        and JSON payload.
*/
function makeRes() {
  const res = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(p) { this.payload = p; return this; },
  };
  return res;
}

/*
     Obj -> ____|_________
           | call() | -> Obj
            ----------
        Runs globalAuth against the given request and returns the response
        plus whether next() was invoked.
*/
function call(req) {
  const res = makeRes();
  let nextCalled = false;
  globalAuth(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

describe("globalAuth — EXPORT_TOKEN bypass", () => {
  const ORIGINAL_TOKEN = process.env.EXPORT_TOKEN;
  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.EXPORT_TOKEN;
    else process.env.EXPORT_TOKEN = ORIGINAL_TOKEN;
  });

  test("rejects /export request without session and without token (401)", () => {
    delete process.env.EXPORT_TOKEN;
    const req = {
      method: "GET",
      path: "/export/interacciones",
      query: {},
      session: {},
    };
    const { res, nextCalled } = call(req);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test("rejects /export request when EXPORT_TOKEN is unset, even if ?token= present", () => {
    delete process.env.EXPORT_TOKEN;
    const req = {
      method: "GET",
      path: "/export/interacciones",
      query: { token: "anything" },
      session: {},
    };
    const { res, nextCalled } = call(req);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test("rejects /export request when token does not match", () => {
    process.env.EXPORT_TOKEN = "real-secret";
    const req = {
      method: "GET",
      path: "/export/interacciones",
      query: { token: "wrong" },
      session: {},
    };
    const { res, nextCalled } = call(req);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test("accepts /export request with matching token (mounted path /export/...)", () => {
    process.env.EXPORT_TOKEN = "real-secret";
    const req = {
      method: "GET",
      path: "/export/interacciones",
      query: { token: "real-secret" },
      session: {},
    };
    const { res, nextCalled } = call(req);
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(null);
    expect(req.userRole).toBe("profesor");
    expect(req.userId).toBe("export-token");
  });

  test("accepts /export request on full /api/export path (defense-in-depth)", () => {
    process.env.EXPORT_TOKEN = "real-secret";
    const req = {
      method: "GET",
      path: "/api/export/resultados",
      query: { token: "real-secret" },
      session: {},
    };
    const { res, nextCalled } = call(req);
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(null);
    expect(req.userRole).toBe("profesor");
  });

  test("does NOT bypass non-export routes even with matching token", () => {
    process.env.EXPORT_TOKEN = "real-secret";
    const req = {
      method: "GET",
      path: "/usuarios",
      query: { token: "real-secret" },
      session: {},
    };
    const { res, nextCalled } = call(req);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test("normal session login still works when EXPORT_TOKEN is unset", () => {
    delete process.env.EXPORT_TOKEN;
    const req = {
      method: "GET",
      path: "/export/interacciones",
      query: {},
      session: { user: { id: "u1", rol: "profesor" } },
    };
    const { res, nextCalled } = call(req);
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(null);
    expect(req.userRole).toBe("profesor");
    expect(req.userId).toBe("u1");
  });
});
