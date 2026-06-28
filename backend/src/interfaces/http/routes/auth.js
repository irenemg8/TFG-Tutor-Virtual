const { Router } = require("express");
const crypto = require("crypto");
const { AuthorizationCode } = require("simple-oauth2");
const container = require("../../../container");

const router = Router();

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                      AUTH ROUTES                      |
            |  Express router for the CAS OAuth2 login flow plus a   |
            |  DEMO bypass mode, backed by the container's user     |
            |  repository. Mounted at the app root. Endpoints:      |
            |     GET  /api/auth/cas/login     -> redirect to CAS   |
            |     GET  /api/auth/cas/callback   -> redirect (sets    |
            |          session) | error                             |
            |     GET  /api/auth/me            -> Obj | 401         |
            |     GET  /api/auth/logout        -> redirect to CAS   |
            |     POST /api/auth/dev-login      -> Obj   (DEMO)      |
            |     POST /api/auth/dev-logout     -> Obj   (DEMO)      |
            |  Exports { router, requireAuth }.                     |
        ____|________________                                       |
   Txt, Txt -> | assertEnv() | -> void           (warns if missing)  |
              -------------                                          |
        ____|__________________                                      |
        | getUsuarioRepo() | -> UsuarioRepo | null  (reads container)|
        ------------------                                           |
        ____|____________________                                    |
   Obj -> | containerNotReady() | -> Obj          (sends 503)        |
          -------------------                                        |
        ____|_______________                                         |
   Obj, Obj, Fn -> | requireAuth() | -> void      (session guard)    |
                  ---------------                                    |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const {
  CAS_BASE_URL = "https://caspre.upv.es/cas",
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPES = "profile email",
  FRONTEND_BASE_URL,
  DEV_BYPASS_AUTH,
} = process.env;

/*
 Txt, Txt -> ____|________________
            | assertEnv() | -> void
             -------------
    Logs an error when a required OAuth env var is missing, so the misconfig
    is visible at boot. Does not throw.
*/
function assertEnv(name, value) {
  if (!value) {
    console.error(`[AUTH ENV] Falta variable ${name}. Revisa tu .env cargado.`);
  }
}
assertEnv("OAUTH_CLIENT_ID", OAUTH_CLIENT_ID);
assertEnv("OAUTH_REDIRECT_URI", OAUTH_REDIRECT_URI);

const casUrl = new URL(CAS_BASE_URL);
const CAS_ORIGIN = casUrl.origin;
const CAS_PATH = casUrl.pathname.replace(/\/$/, "");

const oauthClient = new AuthorizationCode({
  client: { id: OAUTH_CLIENT_ID, secret: OAUTH_CLIENT_SECRET },
  auth: {
    tokenHost: CAS_ORIGIN,
    authorizePath: `${CAS_PATH}/oauth2.0/authorize`,
    tokenPath: `${CAS_PATH}/oauth2.0/accessToken`,
  },
  http: { json: true },
});

/*
       ____|__________________
      | getUsuarioRepo() | -> UsuarioRepo | null    (reads container (Obj))
       ------------------
    Resolves the user repository lazily so routes can register before the
    container finishes initializing. Returns null when not ready yet.
*/
function getUsuarioRepo() {
  if (!container._initialized || !container.usuarioRepo) return null;
  return container.usuarioRepo;
}

/*
 Obj -> ____|____________________
       | containerNotReady() | -> Obj    (sends 503)
        -------------------
    Sends a 503 service_unavailable response while persistence is not ready.
*/
function containerNotReady(res) {
  return res.status(503).json({
    error: "service_unavailable",
    message: "Persistence layer not ready yet. Try again in a moment.",
  });
}

router.get("/api/auth/cas/login", async (req, res) => {
  console.log("[CAS LOGIN] start", { returnTo: req.query.returnTo });
  try {
    const state = crypto.randomBytes(16).toString("hex");
    const returnTo = req.query.returnTo || `${FRONTEND_BASE_URL || "/"}`;
    req.session.oauthState = state;
    req.session.returnTo = returnTo;

    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    const authorizationUri = oauthClient.authorizeURL({
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPES,
      state,
    });
    console.log("[CAS LOGIN] redirect to CAS", { state: state.substring(0, 8) + "...", returnTo });
    return res.redirect(authorizationUri);
  } catch (err) {
    console.error("[CAS LOGIN ERROR]", err);
    return res.status(500).send("No se pudo iniciar el login con CAS: " + (err.message || "error desconocido"));
  }
});

router.get("/api/auth/cas/callback", async (req, res) => {
  console.log("[CAS CALLBACK] start", {
    hasCode: !!req.query.code,
    hasState: !!req.query.state,
    sessionHasState: !!req.session?.oauthState,
  });
  const usuarioRepo = getUsuarioRepo();
  if (!usuarioRepo) {
    console.error("[CAS CALLBACK] container not ready");
    return containerNotReady(res);
  }

  try {
    const { code, state } = req.query;
    if (!code || state !== req.session.oauthState) {
      console.error("[CAS ERROR] State no coincide o code no recibido.", {
        receivedState: state?.substring(0, 8) + "...",
        sessionState: req.session?.oauthState?.substring(0, 8) + "...",
      });
      return res.status(400).send("Solicitud inválida (state/code).");
    }

    const tokenParams = {
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPES,
    };

    let accessToken;
    try {
      accessToken = await oauthClient.getToken(tokenParams);
    } catch (e) {
      console.error("[CAS TOKEN ERROR]", {
        message: e?.message, status: e?.response?.status,
        data: e?.response?.data, headers: e?.response?.headers,
      });
      return res.status(500).send(
        "Error token CAS: " +
          (e?.response?.status ? `HTTP ${e.response.status} ` : "") +
          (e?.response?.data ? JSON.stringify(e.response.data) : e?.message || "sin detalle")
      );
    }

    const rawToken = accessToken?.token?.access_token;
    if (!rawToken) {
      console.error("[CAS TOKEN ERROR] access_token vacío:", accessToken);
      return res.status(500).send("Error token CAS: access_token vacío.");
    }

    const profileResp = await fetch(`${CAS_ORIGIN}${CAS_PATH}/oauth2.0/profile`, {
      headers: { Authorization: `Bearer ${rawToken}` },
    });
    if (!profileResp.ok) {
      const txt = await profileResp.text().catch(() => "");
      throw new Error(
        `Fallo al obtener el perfil de CAS: HTTP ${profileResp.status} ${profileResp.statusText} ${txt}`
      );
    }

    const profile = await profileResp.json();
    const attrs = profile.attributes || profile || {};
    const upvLogin = attrs.login || attrs.uid || profile.id;
    const email = attrs.email || null;
    const firstName = attrs.nombre || attrs.given_name || attrs.name || null;
    const lastName = attrs.apellidos || attrs.family_name || null;
    const nationalId = attrs.dni || null;
    const groups = Array.isArray(attrs.grupos) ? attrs.grupos : [];

    if (!upvLogin) {
      return res.status(500).send("CAS no devolvió identificador de usuario (upvLogin).");
    }

    console.log("[CAS CALLBACK] upsert usuario", { upvLogin });
    const usuario = await usuarioRepo.upsertByUpvLogin(
      upvLogin,
      { email, firstName, lastName, nationalId },
      { groups }
    );
    console.log("[CAS CALLBACK] usuario OK", { id: usuario.id, upvLogin: usuario.upvLogin });

    usuarioRepo.updateById(usuario.id, { lastLoginAt: new Date() }).catch((e) => {
      console.warn("[CAS CALLBACK] updateById lastLoginAt failed (ignoring):", e.message);
    });

    req.session.user = {
      id: usuario.id,
      upvLogin: usuario.upvLogin,
      nombre: usuario.firstName,
      apellidos: usuario.lastName,
      email: usuario.email,
      rol: usuario.role || "alumno",
      mode: "cas",
    };

    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    const goto = req.session.returnTo || `${FRONTEND_BASE_URL || "/"}`;
    delete req.session.oauthState;
    delete req.session.returnTo;

    const setCookieHeader = res.getHeader && res.getHeader("set-cookie");
    console.log("[CAS CALLBACK] session saved + redirect", {
      sessionId: req.sessionID,
      userId: req.session.user && req.session.user.id,
      goto,
      setCookieEmitted: Array.isArray(setCookieHeader)
        ? setCookieHeader.length
        : setCookieHeader
        ? 1
        : 0,
    });
    return res.redirect(goto);
  } catch (err) {
    console.error("[CAS FATAL ERROR]", {
      message: err?.message, status: err?.response?.status,
      data: err?.response?.data, stack: err?.stack,
    });
    return res.status(500).send(
      "Error en callback CAS: " +
        (err?.response?.status ? `HTTP ${err.response.status} ` : "") +
        (err?.response?.data ? JSON.stringify(err.response.data) : err?.message || "sin detalle")
    );
  }
});

router.get("/api/auth/me", (req, res) => {
  if (!req.session?.user) {
    console.warn("[AUTH /me] 401 not authenticated", {
      sessionId: req.sessionID,
      hasCookieHeader: Boolean(req.headers && req.headers.cookie),
      cookieNames: req.headers && req.headers.cookie
        ? req.headers.cookie.split(";").map((c) => c.trim().split("=")[0]).join(",")
        : "",
      sessionExists: Boolean(req.session),
      hasUser: false,
    });
    return res.status(401).json({ authenticated: false });
  }
  return res.json({ authenticated: true, user: req.session.user });
});

router.get("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    const url = new URL(`${CAS_ORIGIN}${CAS_PATH}/logout`);
    if (FRONTEND_BASE_URL) url.searchParams.set("service", FRONTEND_BASE_URL);
    res.redirect(url.toString());
  });
});

/*
 Obj, Obj, Fn -> ____|_______________
                | requireAuth() | -> void
                 ---------------
    Route guard for protected endpoints: responds 401 when there is no
    session user, otherwise passes control to the next handler.
*/
function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "No autenticado" });
  }
  next();
}

router.post("/api/auth/dev-login", async (req, res) => {
  if (DEV_BYPASS_AUTH !== "true") {
    return res.status(403).json({ error: "DEV_BYPASS_AUTH deshabilitado en el servidor" });
  }
  const usuarioRepo = getUsuarioRepo();
  if (!usuarioRepo) return containerNotReady(res);

  try {
    if (req.session?.user?.id) {
      return res.json({ ok: true, user: req.session.user });
    }

    const demoKey = crypto.randomBytes(16).toString("hex");
    const upvLogin = `demo_${demoKey}`;

    const usuario = await usuarioRepo.create({
      upvLogin,
      firstName: "Usuario",
      lastName: "Demo",
      email: `${upvLogin}@demo.local`,
    });
    await usuarioRepo.updateById(usuario.id, { lastLoginAt: new Date() });

    req.session.user = {
      id: usuario.id,
      upvLogin: usuario.upvLogin,
      nombre: usuario.firstName,
      apellidos: usuario.lastName,
      email: usuario.email,
      rol: usuario.role || "alumno",
      mode: "demo",
    };

    return res.json({ ok: true, user: req.session.user });
  } catch (err) {
    console.error("[DEV LOGIN ERROR]", err);
    return res.status(500).json({ error: "Error creando sesión demo" });
  }
});

router.post("/api/auth/dev-logout", (req, res) => {
  if (DEV_BYPASS_AUTH !== "true") {
    return res.status(403).json({ error: "DEV_BYPASS_AUTH deshabilitado en el servidor" });
  }
  req.session.destroy(() => res.json({ ok: true }));
});

module.exports = { router, requireAuth };
