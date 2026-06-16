/*------------------------------------------------------------------------------
            _________________________________________________________
            |                 INDEX / SERVER ENTRYPOINT             |
            |  Boots the Express app: CORS, sessions on PostgreSQL, |
            |  static assets, auth middleware, API routes and SPA   |
            |  fallback. Starts the internal HTTP server, then       |
            |  initializes the hex DI container and Ollama warmup.  |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const cors = require("cors");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const fs = require("fs");




const userRoutes = require("./interfaces/http/routes/usuarios");
const ejerciciosRoutes = require("./interfaces/http/routes/ejercicios");
const interaccionesRoutes = require("./interfaces/http/routes/interacciones");
const ollamaChatRoutes = require("./interfaces/http/routes/ollamaChatRoutes");
const orchestratorMiddleware = require("./interfaces/http/middleware/orchestratorMiddleware");
const ragMiddleware = require("./interfaces/http/middleware/ragMiddleware");
const { setupWorkflowSocket } = require("./interfaces/sse/workflowSocket");
const container = require("./container");
const resultadoRoutes = require("./interfaces/http/routes/resultados");
const progresoRoutes = require("./interfaces/http/routes/progresoRoutes");
const exportRoutes = require("./interfaces/http/routes/exportRoutes");

const { router: authRouter, requireAuth } = require("./interfaces/http/routes/auth");
const { globalAuth, requireRole } = require("./interfaces/http/middleware/authMiddleware");

const app = express();
console.log("✅ BACKEND INDEX CARGADO:", __filename);

if (
  process.env.DEV_BYPASS_AUTH === "true" &&
  process.env.NODE_ENV === "production"
) {
  console.error(
    "CRITICAL: DEV_BYPASS_AUTH is enabled in production. Refusing to start."
  );
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);

app.set("trust proxy", 1);

app.use(
  cors({
    origin: [
      process.env.FRONTEND_BASE_URL || "http://localhost:5173",
      process.env.WORKFLOW_BASE_URL || "http://localhost:5174",
    ].map((u) => {
      try { return new URL(u).origin; } catch { return u; }
    }),
    credentials: true,
  })
);

app.use(express.json());

const staticDir = path.join(__dirname, "static");
console.log("STATIC DIR =", staticDir);
console.log("STATIC EXISTS =", fs.existsSync(staticDir));
if (fs.existsSync(staticDir)) {
  console.log("STATIC FILES =", fs.readdirSync(staticDir).slice(0, 50));
}

app.get("/api/debug/static", (_req, res) => {
  res.json({
    ok: true,
    staticDir,
    exists: fs.existsSync(staticDir),
    files: fs.existsSync(staticDir) ? fs.readdirSync(staticDir).slice(0, 50) : [],
  });
});

app.use("/static", express.static(staticDir, { fallthrough: false }));

const pgStore = new PgSession({
  conString: process.env.PG_CONNECTION_STRING,
  tableName: "sessions",
  createTableIfMissing: false,
  errorLog: function (msg) { console.error("[SESSION STORE]", msg); },
});
const isProduction = process.env.NODE_ENV === "production";
const devBypass = process.env.DEV_BYPASS_AUTH === "true";
app.use(
  session({
    name: "sid_irene",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: pgStore,
    cookie: {
      httpOnly: true,
      secure: isProduction && !devBypass,
      sameSite: "lax",
      path: "/",
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use(authRouter);

app.use("/api", globalAuth);

app.use("/api/usuarios", userRoutes);
app.use("/api/ejercicios", ejerciciosRoutes);
app.use("/api/interacciones", interaccionesRoutes);
app.use("/api/ollama", orchestratorMiddleware);
app.use("/api/ollama", (req, res, next) => {
  if (req.path === "/chat/stream") {
    console.warn(
      "[DEPRECATED] ragMiddleware fallback hit — orchestrator did not handle request. " +
      "Check orchestrator health or set USE_ORCHESTRATOR=1."
    );
  }
  next();
});
app.use("/api/ollama", ragMiddleware);
app.use("/api/ollama", ollamaChatRoutes);
app.use("/api/progreso", progresoRoutes);
app.use("/api/resultados", resultadoRoutes);
app.use("/api/export", exportRoutes);

app.post("/api/llm/query", requireAuth, (req, res) => {
  res.json({ ok: true, user: req.session.user });
});

const frontendDist = path.join(__dirname, "..", "..", "frontend", "dist");
console.log("FRONTEND DIST =", frontendDist);

app.use(
  express.static(frontendDist, {
    immutable: true,
    maxAge: "365d",
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("Surrogate-Control", "no-store");
      }
    },
  })
);

app.get(/^\/(?!api\/|static\/).*/, (req, res, next) => {
  if (path.extname(req.path)) {
    return res.status(404).type("text/plain").send("Not found");
  }
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.sendFile(path.join(frontendDist, "index.html"));
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Backend (HTTP interno) escuchando en puerto ${port}`);

  container.initialize()
    .then(() => {
      console.log("[Startup] Hex container ready. USE_ORCHESTRATOR=" + (process.env.USE_ORCHESTRATOR === "1" ? "ON" : "OFF"));
    })
    .catch((err) => {
      console.error("[Startup] Container initialization FAILED — orchestrator route disabled:", err.message);
    });

  const axios = require("axios");

  /*
       ____|________
      | warmupOllamaUPV() | -> Promise<void>
       -------------
      Pings the UPV Ollama endpoint to preload the model. No-op unless
      LLM_PROVIDER=ollama and a UPV URL is configured.
  */
  async function warmupOllamaUPV() {
    if ((process.env.LLM_PROVIDER || "ollama").toLowerCase() !== "ollama") {
      console.log("[OLLAMA] Warmup SKIP (LLM_PROVIDER=" + process.env.LLM_PROVIDER + ").");
      return;
    }
    const upvUrl = process.env.OLLAMA_API_URL_UPV || process.env.OLLAMA_BASE_URL_UPV;
    if (!upvUrl) {
      console.log("[OLLAMA] Warmup SKIP (OLLAMA_API_URL_UPV no definido).");
      return;
    }

    const url = String(upvUrl).replace(/\/$/, "");
    const model = process.env.OLLAMA_MODEL || "qwen2.5:latest";
    const keepAlive = process.env.OLLAMA_KEEP_ALIVE || "60m";

    try {
      console.log("[OLLAMA] Warmup (UPV)...");
      await axios.post(
        `${url}/api/chat`,
        {
          model,
          stream: false,
          keep_alive: keepAlive,
          messages: [
            { role: "system", content: "Responde solo con OK." },
            { role: "user", content: "OK" },
          ],
          options: { num_predict: 1, temperature: 0 },
        },
        { timeout: 20000 }
      );
      console.log("[OLLAMA] Warmup OK (UPV)");
    } catch (e) {
      console.warn("[OLLAMA] Warmup FAILED (UPV):", e?.message || e);
    }
  }

  warmupOllamaUPV();
});

setupWorkflowSocket(server);
