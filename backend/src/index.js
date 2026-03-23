// backend/src/index.js
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const fs = require("fs");

// Rutas




const userRoutes = require("./routes/usuarios");
const ejerciciosRoutes = require("./routes/ejercicios");
const interaccionesRoutes = require("./routes/interacciones");
const ollamaChatRoutes = require("./routes/ollamaChatRoutes");
const resultadoRoutes = require("./routes/resultados");
const progresoRoutes = require("./routes/progresoRoutes");

// Auth (CAS + demo)
const { router: authRouter, requireAuth } = require("./authRoutes");

const app = express();
console.log("✅ BACKEND INDEX CARGADO:", __filename);

const port = Number(process.env.PORT || 3000);

// ✅ Si estás detrás de Nginx (HTTPS fuera), esto es obligatorio para cookies secure
app.set("trust proxy", 1);

// ====== CORS ======
app.use(
  cors({
    origin: process.env.FRONTEND_BASE_URL || "http://localhost:5173",
    credentials: true,
  })
);

// ====== Middlewares base ======
app.use(express.json());

// ====== Static (imágenes ejercicios) ======
// Tus imágenes están en: backend/src/static
const staticDir = path.join(__dirname, "static");
console.log("STATIC DIR =", staticDir);
console.log("STATIC EXISTS =", fs.existsSync(staticDir));
if (fs.existsSync(staticDir)) {
  console.log("STATIC FILES =", fs.readdirSync(staticDir).slice(0, 50));
}

// Endpoint de debug (NO está bajo /static para que no lo intercepte express.static)
app.get("/api/debug/static", (_req, res) => {
  res.json({
    ok: true,
    staticDir,
    exists: fs.existsSync(staticDir),
    files: fs.existsSync(staticDir) ? fs.readdirSync(staticDir).slice(0, 50) : [],
  });
});

// Servido real de estáticos
app.use("/static", express.static(staticDir, { fallthrough: false }));

// ====== Mongo ======
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Conectado a MongoDB Atlas"))
  .catch((error) => console.error("Error al conectar a MongoDB:", error));

// ====== Sesión ======
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
    cookie: {
      httpOnly: true,
      // En producción (HTTPS + Nginx) secure debe ser true.
      // En dev local (HTTP) debe ser false o el navegador descarta la cookie.
      secure: process.env.DEV_BYPASS_AUTH !== "true",
      sameSite: "lax",
    },
  })
);

// ====== Healthcheck ======
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ====== Auth ======
app.use(authRouter);

// ====== API ======
app.use("/api/usuarios", userRoutes);
app.use("/api/ejercicios", ejerciciosRoutes);
app.use("/api/interacciones", interaccionesRoutes);
app.use("/api/ollama", ollamaChatRoutes);
app.use("/api/progreso", progresoRoutes);
app.use("/api/resultados", resultadoRoutes);

app.post("/api/llm/query", requireAuth, (req, res) => {
  res.json({ ok: true, user: req.session.user });
});

// ====== Servir FRONTEND (React build) ======
const frontendDist = path.join(__dirname, "..", "..", "frontend", "dist");
console.log("FRONTEND DIST =", frontendDist);

// Assets con caché largo; index.html sin caché
app.use(
  express.static(frontendDist, {
    immutable: true,
    maxAge: "365d",
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

// SPA fallback: NO capturar /api ni /static
app.get(/^\/(?!api\/|static\/).*/, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(frontendDist, "index.html"));
});

// ====== Arranque servidor HTTP interno (Nginx hará HTTPS fuera) ======
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Backend (HTTP interno) escuchando en puerto ${port}`);

  // Warmup Ollama (no bloquea)
  const axios = require("axios");

  async function warmupOllamaUPV() {
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
