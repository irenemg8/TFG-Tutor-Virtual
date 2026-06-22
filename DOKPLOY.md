# Desplegar el Tutor Virtual (Irene) en Dokploy

Este despliegue **sustituye** a la app que hay viva (la de Dennis) por **este
código**, usando el mismo patrón que ya funciona en ese servidor: un solo
contenedor `app` (el backend sirve el frontend compilado) + `postgres` +
`chromadb`, todo en la red `dokploy-network`, servido en la **raíz `/`** y con
el dominio/HTTPS gestionados desde la UI de Dokploy.

| Servicio   | Qué es                          | Acceso                         |
|------------|---------------------------------|--------------------------------|
| `postgres` | Base de datos                   | solo interno                   |
| `chromadb` | Vectorial (RAG)                 | solo interno                   |
| `app`      | Backend + frontend (un contenedor) | `expose 3001` → dominio por UI |

---

## 0) Importante: esto toca el proyecto de Dennis

Como el objetivo es **reemplazar** lo que está vivo, hay que cambiar a qué repo
apunta el despliegue actual (o crear uno nuevo y apagar el suyo). **Coordínalo
con Dennis / tu jefa antes** de tocar su proyecto en Dokploy.

---

## 1) Reúne tus secretos

Los pegarás en el paso 4. **No los subas al repo.**

- `PG_PASSWORD` — invéntate una nueva (solo letras y números)
- `SESSION_SECRET` — cadena larga aleatoria
- `POLIGPT_API_KEY` — tu API key de PoliGPT
- `OAUTH_CLIENT_SECRET` — el secreto del CAS (está en la pestaña *Environment*
  del proyecto de Dennis en Dokploy)
- `EXPORT_TOKEN`

---

## 2) Sube la rama a GitHub

Desde `C:\Users\irene\Desktop\UNIVERSIDAD\TFG\TFG-Tutor-Virtual`:

```powershell
git push origin dokploy
```

Esto sube SOLO la rama `dokploy` a **tu** repo `irenemg8/TFG-Tutor-Virtual`.

---

## 3) Apunta el despliegue a tu repo

**Opción A — reemplazar el servicio existente (recomendada con permiso):**
en el servicio `compose` que ya existe en Dokploy, cambia el **Provider/Repo**
a `irenemg8/TFG-Tutor-Virtual`, **Branch `dokploy`**, **Compose Path
`docker-compose.yml`**.

**Opción B — crear uno nuevo:** Create Project → Create Service → **Compose** →
GitHub `irenemg8/TFG-Tutor-Virtual`, Branch `dokploy`, Compose Path
`docker-compose.yml`. (Luego habría que apagar el de Dennis para liberar el
dominio.)

---

## 4) Variables de entorno

En el servicio → **Environment**, pega el contenido de `.env.example` y rellena
los `<...>`. Las obligatorias (si faltan, el deploy falla aposta):
`PG_PASSWORD`, `SESSION_SECRET`, `POLIGPT_API_KEY`, `OAUTH_CLIENT_SECRET`.

> El resto (`PG_CONNECTION_STRING`, `CHROMA_URL`…) ya las fija el
> `docker-compose.yml` apuntando a los contenedores internos.

---

## 5) Dominio (UI de Dokploy, NO /v2)

En el servicio → pestaña **Domains**: añade `tutor-socratico.gnd.upv.es`,
apuntando al servicio **`app`**, **puerto `3001`**, con HTTPS. Se sirve en la
**raíz `/`**. No hace falta nginx ni labels de Traefik a mano.

> El callback del CAS es `https://tutor-socratico.gnd.upv.es/api/auth/cas/callback`
> (sin `/v2`). Debe coincidir con el registrado en el CAS de la UPV.

---

## 6) Deploy

Pulsa **Deploy**. La primera vez tarda (descarga Postgres/Chroma y compila).
El backend **crea las tablas solo** al arrancar (migraciones SQL en
`backend/src/infrastructure/persistence/postgresql/migrations`).

---

## 7) Cargar los datos del RAG (Chroma empieza vacío)

El contenedor `chromadb` arranca sin datos. Re-ejecuta tu **ingesta** de
material para poblar los embeddings; si no, el RAG no encontrará contexto.

---

## Notas / problemas típicos

- **`dokploy-network` no existe** → suele crearla Dokploy. Con *Isolated
  Deployments* puedes quitar el bloque `networks: dokploy-network` del compose.
- **Cambiaste código** → `git push` a `dokploy` y pulsa **Redeploy**.
- **Logs** → cada servicio tiene su pestaña de logs; míralos si algo no arranca.
- **Chroma da error de API** → el cliente `chromadb@3` usa la API v2; si la
  imagen `latest` cambiara, fija una versión concreta en el compose.
