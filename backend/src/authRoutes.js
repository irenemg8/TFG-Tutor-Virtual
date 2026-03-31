// backend/authRoutes.js
// ✅ CAS OAuth2
// ✅ Compatible con Node 18+ (fetch nativo) y con CAS_BASE_URL que incluye /cas

const { Router } = require("express");
const crypto = require("crypto");
const { AuthorizationCode } = require("simple-oauth2");
const Usuario = require("./models/usuario");

const router = Router();

const {
  CAS_BASE_URL = "https://caspre.upv.es/cas",
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPES = "profile email",
  FRONTEND_BASE_URL,
} = process.env;

// ✅ Validación mínima de configuración (evita client_id=undefined)
function assertEnv(name, value) {
  if (!value) {
    console.error(`[AUTH ENV] Falta variable ${name}. Revisa tu .env cargado.`);
  }
}
assertEnv("OAUTH_CLIENT_ID", OAUTH_CLIENT_ID);
assertEnv("OAUTH_REDIRECT_URI", OAUTH_REDIRECT_URI);

// ✅ CAS_BASE_URL incluye /cas, pero simple-oauth2 requiere origin + paths separados
const casUrl = new URL(CAS_BASE_URL);
const CAS_ORIGIN = casUrl.origin; // https://caspre.upv.es
const CAS_PATH = casUrl.pathname.replace(/\/$/, ""); // /cas

// ✅ Cliente OAuth2 apuntando a CAS (con /cas en paths)
const oauthClient = new AuthorizationCode({
  client: {
    id: OAUTH_CLIENT_ID,
    secret: OAUTH_CLIENT_SECRET,
  },
  auth: {
    tokenHost: CAS_ORIGIN,
    authorizePath: `${CAS_PATH}/oauth2.0/authorize`,
    tokenPath: `${CAS_PATH}/oauth2.0/accessToken`,
  },
  http: { json: true },
});

/* ===================================================================
 * 1. LOGIN CAS
 *    GET /api/auth/cas/login
 * =================================================================== */
router.get("/api/auth/cas/login", async (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString("hex");

    // Ruta de retorno: o lo que pide el front, o Home por defecto
    const returnTo = req.query.returnTo || `${FRONTEND_BASE_URL || "/"}`;
    req.session.oauthState = state;
    req.session.returnTo = returnTo;

    const authorizationUri = oauthClient.authorizeURL({
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPES,
      state,
    });

    return res.redirect(authorizationUri);
  } catch (err) {
    console.error("[CAS LOGIN ERROR]", err);
    return res.status(500).send("No se pudo iniciar el login con CAS.");
  }
});

/* ===================================================================
 * 2. CALLBACK CAS
 *    GET /api/auth/cas/callback
 * =================================================================== */
router.get("/api/auth/cas/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    // Validación de seguridad
    if (!code || state !== req.session.oauthState) {
      console.error("[CAS ERROR] State no coincide o code no recibido.");
      return res.status(400).send("Solicitud inválida (state/code).");
    }

    const tokenParams = {
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPES,
    };

    // ✅ Intercambio code -> access_token (con debug detallado)
    let accessToken;
    try {
      accessToken = await oauthClient.getToken(tokenParams);
    } catch (e) {
      console.error("[CAS TOKEN ERROR]", {
        message: e?.message,
        status: e?.response?.status,
        data: e?.response?.data,
        headers: e?.response?.headers,
      });

      return res
        .status(500)
        .send(
          "Error token CAS: " +
            (e?.response?.status ? `HTTP ${e.response.status} ` : "") +
            (e?.response?.data
              ? JSON.stringify(e.response.data)
              : e?.message || "sin detalle")
        );
    }

    const rawToken = accessToken?.token?.access_token;
    if (!rawToken) {
      console.error("[CAS TOKEN ERROR] access_token vacío:", accessToken);
      return res.status(500).send("Error token CAS: access_token vacío.");
    }

    // ✅ Perfil (Node 18+ fetch nativo; NO uses require('node-fetch') en CommonJS)
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

    // Normalizar atributos
    const attrs = profile.attributes || profile || {};
    const upvLogin = attrs.login || attrs.uid || profile.id;
    const email = attrs.email || null;
    const nombre = attrs.nombre || attrs.given_name || attrs.name || null;
    const apellidos = attrs.apellidos || attrs.family_name || null;
    const dni = attrs.dni || null;
    const grupos = Array.isArray(attrs.grupos) ? attrs.grupos : [];

    if (!upvLogin) {
      return res
        .status(500)
        .send("CAS no devolvió identificador de usuario (upvLogin).");
    }

    // Upsert en Mongo
    const usuario = await Usuario.findOneAndUpdate(
      { upvLogin },
      {
        $set: { email, nombre, apellidos, dni },
        $setOnInsert: { grupos },
      },
      { new: true, upsert: true }
    );

    usuario.lastLoginAt = new Date();
    await usuario.save();

    // Guardar usuario en sesión
    req.session.user = {
      id: usuario._id.toString(),
      upvLogin: usuario.upvLogin,
      nombre: usuario.nombre,
      apellidos: usuario.apellidos,
      email: usuario.email,
      rol: usuario.rol || "alumno",
      mode: "cas",
    };

    // Redirigir al front
    const goto = req.session.returnTo || `${FRONTEND_BASE_URL || "/"}`;
    delete req.session.oauthState;
    delete req.session.returnTo;

    return res.redirect(goto);
  } catch (err) {
    console.error("[CAS FATAL ERROR]", {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data,
      stack: err?.stack,
    });

    return res.status(500).send(
      "Error en callback CAS: " +
        (err?.response?.status ? `HTTP ${err.response.status} ` : "") +
        (err?.response?.data
          ? JSON.stringify(err.response.data)
          : err?.message || "sin detalle")
    );
  }
});

/* ===================================================================
 * 3. ENDPOINTS DE SESIÓN
 * =================================================================== */
router.get("/api/auth/me", (req, res) => {
  if (!req.session?.user) {
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

/* ===================================================================
 * 4. MIDDLEWARE PARA RUTAS PROTEGIDAS
 * =================================================================== */
function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "No autenticado" });
  }
  next();
}

function requireProfesor(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "No autenticado" });
  }
  if (req.session.user.rol !== "profesor") {
    return res.status(403).json({ error: "Acceso restringido a profesores" });
  }
  next();
}

module.exports = {
  router,
  requireAuth,
  requireProfesor,
};
