# =============================================================================
# Stage 1: Build the React frontend
# =============================================================================
FROM node:20-alpine AS frontend-builder

# Build-time variables (baked into the JS bundle by Vite)
ARG VITE_BASE_PATH=""
ARG VITE_BACKEND_URL=""
ARG VITE_DEV_BYPASS_AUTH=false

ENV VITE_BASE_PATH=$VITE_BASE_PATH
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_DEV_BYPASS_AUTH=$VITE_DEV_BYPASS_AUTH

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# =============================================================================
# Stage 2: Backend runtime (serves API + frontend static files)
# =============================================================================
FROM node:20-alpine AS backend

WORKDIR /app/backend

# Install production dependencies only (no nodemon)
COPY backend/package*.json ./
RUN npm ci --omit=dev

# Copy backend source
COPY backend/ ./

# Copy the frontend build into the location the backend expects:
# path.join(__dirname, '..', '..', 'frontend', 'dist') from backend/src/
# resolves to /app/frontend/dist inside the container
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

EXPOSE 3000

# Use node directly (not nodemon) for production
CMD ["node", "src/index.js"]
