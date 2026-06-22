# ============================================================
#  Tutor Virtual (Irene) — imagen ÚNICA para Dokploy
#
#  Estructura tomada del despliegue de Dennis (probado en este
#  Dokploy) pero apuntada a ESTE código:
#    Stage 1  build del frontend (Vite) -> dist
#    Stage 2  instala deps de producción del backend
#    Stage 3  imagen final: el BACKEND sirve el frontend ya
#             compilado y expone el puerto 3001.
#
#  Base Debian slim (glibc), NO alpine: el backend usa
#  @chroma-core/default-embed (onnxruntime), que puede no tener
#  binarios para musl/alpine.
# ============================================================

# ---------- Stage 1: build del frontend (React/Vite) ----------
FROM node:22-bookworm-slim AS frontend-builder
ARG VITE_BASE_PATH
ARG VITE_BACKEND_URL
ARG VITE_DEV_BYPASS_AUTH
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
# Vite lee estas variables en tiempo de build
RUN printf "VITE_BASE_PATH=%s\nVITE_BACKEND_URL=%s\nVITE_DEV_BYPASS_AUTH=%s\n" \
    "$VITE_BASE_PATH" "$VITE_BACKEND_URL" "$VITE_DEV_BYPASS_AUTH" > .env
RUN npm run build

# ---------- Stage 2: deps de producción del backend ----------
FROM node:22-bookworm-slim AS backend-deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
# --ignore-scripts evita compilar onnxruntime (no se usa: los
# embeddings van por PoliGPT/OpenAI, no por el default-embed local)
RUN npm ci --omit=dev --ignore-scripts

# ---------- Stage 3: imagen de producción ----------
FROM node:22-bookworm-slim AS production
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# Backend: deps + código. Los datos del RAG (backend/src/data) y las
# migraciones SQL (backend/src/infrastructure/.../migrations) viven
# dentro de backend/src, así que se copian con esta línea.
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY backend/package.json backend/package-lock.json ./backend/
COPY backend/src ./backend/src

# Frontend ya compilado (el backend lo sirve estáticamente en /)
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Carpeta de logs creada con dueño 'node' para que el volumen de
# Dokploy herede permisos correctos (si no, fallaría al escribir).
RUN mkdir -p /app/backend/logs/rag && chown -R node:node /app
USER node

EXPOSE 3001
CMD ["node", "backend/src/index.js"]
