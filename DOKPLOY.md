# Desplegar el Tutor Virtual en Dokploy

Guía paso a paso. Todo lo tuyo va en contenedores Docker **aislados**: no
toca nada de lo de Dennis.

Servicios que se levantan (un solo `docker-compose.yml`):

| Servicio   | Qué es                  | Acceso        |
|------------|-------------------------|---------------|
| `postgres` | Base de datos           | solo interno  |
| `chroma`   | Vectorial (RAG)         | solo interno  |
| `backend`  | API Node/Express        | solo interno  |
| `frontend` | React + nginx (`/v2/`)  | puerto host   |

---

## 1) Antes de empezar — reúne tus secretos

Sácalos de tu `.env` del servidor Windows
(`C:\Users\admin\TutorVirtual_Irene\backend\.env`). Los necesitarás en el
paso 4. **No los subas al repo.**

- `POSTGRES_PASSWORD` — invéntate una nueva (solo letras y números, sin `@`, `:`, `/`)
- `SESSION_SECRET`
- `POLIGPT_API_KEY`
- `OAUTH_CLIENT_SECRET`
- `EXPORT_TOKEN`

---

## 2) Sube la rama a GitHub

Desde `C:\Users\irene\Desktop\UNIVERSIDAD\TFG\TFG-Tutor-Virtual`:

```powershell
git add docker-compose.yml DOKPLOY.md backend/Dockerfile backend/.dockerignore frontend/Dockerfile frontend/.dockerignore frontend/nginx.conf
git commit -m "chore(deploy): dockerizar para Dokploy"
git push -u origin dokploy
```

Esto sube SOLO la rama `dokploy` a **tu** repo `irenemg8/TFG-Tutor-Virtual`.
No afecta a `main`, ni a Dennis, ni a producción.

---

## 3) Crea la aplicación en Dokploy

1. Entra a `http://158.42.148.30:3000`.
2. **Create Project** → ponle un nombre tuyo (p. ej. `tutor-virtual-irene`).
3. Dentro del proyecto: **Create Service → Compose**.
4. **Provider: GitHub** → repo `irenemg8/TFG-Tutor-Virtual`, **Branch: `dokploy`**.
5. **Compose Path**: `docker-compose.yml` (en la raíz).

> Si Dokploy te pide conectar GitHub primero, sigue su asistente para
> autorizar tu cuenta. Si tu repo es privado, tendrás que darle acceso.

---

## 4) Pega las variables de entorno

En la aplicación → pestaña **Environment**, pega esto y **rellena los `<...>`**:

```
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<tu_password_nueva_solo_alfanumerica>
POSTGRES_DB=tutorvirtual

FRONTEND_HOST_PORT=8082

SERVER_BASE_URL=https://tutor-socratico.gnd.upv.es/v2
FRONTEND_BASE_URL=https://tutor-socratico.gnd.upv.es/v2

SESSION_SECRET=<cadena_larga_aleatoria>

LLM_PROVIDER=poligpt
EMBEDDING_PROVIDER=openai
POLIGPT_BASE_URL=https://api.poligpt.upv.es
POLIGPT_API_KEY=<tu_api_key_poligpt>
POLIGPT_MODEL=qwen2.5vl:32b
POLIGPT_EMBED_MODEL=nomic-embed-text

USE_ORCHESTRATOR=1
ORCHESTRATOR_BUDGET_MS=90000
GUARDRAIL_BUDGET_MS=20000
GUARDRAIL_MIN_RETRY_BUDGET_MS=10000
ORCHESTRATOR_STREAM_TOKENS=1
AUDIT_LOG=1
DEV_BYPASS_AUTH=false

CAS_BASE_URL=https://caspre.upv.es/cas
OAUTH_CLIENT_ID=TUTOR-VIRTUAL
OAUTH_CLIENT_SECRET=<secreto_cas>
OAUTH_REDIRECT_URI=https://tutor-socratico.gnd.upv.es/v2/api/auth/cas/callback
OAUTH_SCOPES=profile email

EXPORT_TOKEN=<token_export>
```

> El `PG_CONNECTION_STRING` y el `CHROMA_URL` **no** se ponen aquí: el
> `docker-compose.yml` ya los fija apuntando a los contenedores internos.

---

## 5) Deploy

Pulsa **Deploy**. Dokploy clona la rama, construye las imágenes y levanta los
4 contenedores. La primera vez tarda (descarga Postgres, Chroma y compila).

El backend **crea las tablas solo** al arrancar (corre las migraciones SQL).

**Prueba directa:** `http://158.42.148.30:8082/v2/`
(si cambiaste `FRONTEND_HOST_PORT`, usa ese puerto).

---

## 6) El dominio `/v2/` (coordinar con Dennis)

Tu app espera vivir bajo `https://tutor-socratico.gnd.upv.es/v2/`. Quien
gestione el proxy de delante (Traefik de Dokploy o el nginx del servidor)
debe reenviar **todo `/v2`** al servicio `frontend` (puerto 80) **SIN quitar
el prefijo `/v2`**. Pregúntale a Dennis cómo está montado el enrutado del
dominio y pásale ese dato.

---

## 7) Cargar los datos del RAG (Chroma empieza vacío)

El contenedor `chroma` arranca sin datos. Tendrás que **re-ejecutar tu
ingesta** de material para poblar los embeddings (igual que hacías en el
servidor Windows, pero apuntando al nuevo Chroma). Si no, el RAG no
encontrará contexto.

---

## Notas / problemas típicos

- **El puerto 8082 ya está usado** → cambia `FRONTEND_HOST_PORT` a otro libre.
- **Falla la build de Chroma/onnx** → el backend usa imagen Debian (no alpine)
  justo para evitar eso; si Chroma da error de API, ajusta la versión
  `chromadb/chroma:0.5.23` del compose a la de tu cliente.
- **Cambiaste código** → haz `git push` a la rama `dokploy` y pulsa **Redeploy**.
- **Logs** → cada servicio tiene su pestaña de logs en Dokploy; míralos si algo
  no arranca.
