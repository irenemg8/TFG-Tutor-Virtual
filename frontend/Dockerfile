# ============================================================
#  Frontend (Vite/React) — build + nginx, imagen para Dokploy
#  Se construye con base path /v2 y se sirve estático con nginx,
#  que además hace de proxy de /v2/api hacia el contenedor backend.
# ============================================================

# ---- 1) Build de la SPA ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# La app se monta bajo /v2 y llama a la API en /v2 (mismo prefijo)
ARG VITE_BASE_PATH=/v2
ARG VITE_BACKEND_URL=/v2
ENV VITE_BASE_PATH=$VITE_BASE_PATH
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
RUN npm run build

# ---- 2) Servir con nginx ----
FROM nginx:1.27-alpine AS runner

# La SPA se sirve bajo /v2/ (los assets referencian /v2/...)
COPY --from=build /app/dist /usr/share/nginx/html/v2
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
