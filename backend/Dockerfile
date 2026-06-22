# ============================================================
#  Backend (Node + Express) — imagen para Dokploy
#  Usa Debian slim (glibc) en vez de alpine porque chromadb /
#  onnxruntime pueden no tener binarios precompilados para musl.
# ============================================================
FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# Instalar dependencias primero (mejor cache de capas)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copiar el resto del código (node_modules, .env, logs, certs y
# chroma quedan excluidos por .dockerignore)
COPY . .

EXPOSE 3001

# El backend escucha en 0.0.0.0:3001 y corre las migraciones SQL al arrancar
CMD ["node", "src/index.js"]
