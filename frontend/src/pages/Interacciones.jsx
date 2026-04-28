// frontend/src/pages/Interacciones.jsx
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { getCurrentUser } from "../services/auth";
import { api } from "../services/api";
import MessageRenderer from "../components/MessageRenderer";

const FIN_TOKEN = "<FIN_EJERCICIO>";

function containsFinishToken(text) {
  return typeof text === "string" && text.includes(FIN_TOKEN);
}

// ✅ Limpieza robusta para streaming + re-entrada (token partido o pegado al final)
function stripFinishTokenStreaming(text) {
  if (typeof text !== "string") return "";

  let out = text.replaceAll(FIN_TOKEN, "");

  // recorta prefijos del token si están al final (token partido)
  for (let k = FIN_TOKEN.length - 1; k > 0; k--) {
    const prefix = FIN_TOKEN.slice(0, k);
    if (out.endsWith(prefix)) {
      out = out.slice(0, -k);
      break;
    }
  }

  return out.trimEnd();
}

// ✅ limpia tokens en conversaciones cargadas desde BD (re-entrada)
function sanitizeConversation(conversacion) {
  if (!Array.isArray(conversacion)) return [];
  return conversacion.map((m) => {
    if (!m || typeof m !== "object") return m;
    if (m.role !== "assistant") return m;
    return { ...m, content: stripFinishTokenStreaming(m.content || "") };
  });
}

function safeDateLabel(d) {
  try {
    if (!d) return "";
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return "";
    return dt.toLocaleString("es-ES", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/**
 * SSE por POST (fetch stream) — parser robusto:
 * - soporta eventos con varias líneas data:
 * - soporta [DONE], {chunk}, {interaccionId}, {error}
 */
async function enviarMensajeStream({
  payload,
  signal,
  onInteraccionId,
  onChunk,
  onDone,
  onError,
}) {
  const basePath = import.meta.env.VITE_BASE_PATH || "";
  try {
    const resp = await fetch(basePath + "/api/ollama/chat/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-llm-mode": payload?.llmMode || "upv",
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} ${resp.statusText} ${txt}`);
    }
    if (!resp.body) throw new Error("Streaming no soportado (resp.body null).");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    // ✅ evita que onDone se dispare dos veces
    let doneCalled = false;
    const safeDone = () => {
      if (doneCalled) return;
      doneCalled = true;
      onDone?.();
    };

    const handleData = (raw) => {
      const s = String(raw ?? "").trim();
      if (!s) return;

      if (s === "[DONE]") {
        safeDone();
        return;
      }

      try {
        const msg = JSON.parse(s);

        if (msg?.error) {
          onError?.(new Error(msg.error));
          return;
        }
        if (msg?.interaccionId) {
          onInteraccionId?.(msg.interaccionId);
          return;
        }
        if (typeof msg?.chunk === "string" && msg.chunk.length > 0) {
          onChunk?.(msg.chunk);
        }
      } catch {
        // ignore
      }
    };

    const process = () => {
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const ev of events) {
        const lines = ev.split("\n").filter(Boolean);

        // un evento puede traer varias líneas data:
        for (const ln of lines) {
          if (!ln.startsWith("data:")) continue;
          handleData(ln.replace(/^data:\s*/, ""));
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      process();
    }

    process();
    safeDone();
  } catch (e) {
    if (e?.name === "AbortError") return; // ✅ abort ≠ error real
    onError?.(e);
  }
}

export default function Interacciones() {
  const [currentChatMessages, setCurrentChatMessages] = useState([]);
  const [ejerciciosDisponibles, setEjerciciosDisponibles] = useState([]);
  const [ejercicioActualId, setEjercicioActualId] = useState(null);
  const [nuevoMensaje, setNuevoMensaje] = useState("");
  const [currentInteraccionId, setCurrentInteraccionId] = useState(null);

  const [userId, setUserId] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [isMobileView, setIsMobileView] = useState(false);
  const [mostrarPanel, setMostrarPanel] = useState(true);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const savedWidth = localStorage.getItem("sidebarWidth");
    return savedWidth ? parseInt(savedWidth, 10) : 320;
  });
  const [isResizing, setIsResizing] = useState(false);

  const [loading, setLoading] = useState(true);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const sendingRef = useRef(false);

  // ✅ indicador “pensando…”
  const [isTutorThinking, setIsTutorThinking] = useState(false);
  const firstChunkRef = useRef(false);

  const [sidebarInteractions, setSidebarInteractions] = useState([]);
  const [showPlusPanel, setShowPlusPanel] = useState(false);
  const [queryEj, setQueryEj] = useState("");

  const [showImageModal, setShowImageModal] = useState(false);
  const [modalImageUrl, setModalImageUrl] = useState("");
  const [modalImageAlt, setModalImageAlt] = useState("");

  // ✅ modal intentos
  const [showAttemptsModal, setShowAttemptsModal] = useState(false);

  const location = useLocation();
  const navigate = useNavigate();
  const scrollRef = useRef(null);

  // abort del stream actual si el usuario cambia de chat
  const activeAbortRef = useRef(null);

  // ✅ evita procesar FIN más de una vez por mensaje
  const finHandledRef = useRef(false);

  // ✅ refs para evitar “closures viejos”
  const interaccionIdRef = useRef(null);
  const currentChatMessagesRef = useRef([]);

  useEffect(() => {
    interaccionIdRef.current = currentInteraccionId;
  }, [currentInteraccionId]);

  useEffect(() => {
    currentChatMessagesRef.current = currentChatMessages;
  }, [currentChatMessages]);

  // móvil
  useEffect(() => {
    const compute = () => setIsMobileView(window.innerWidth <= 640);
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  useEffect(() => {
    if (!isMobileView) setMostrarPanel(true);
  }, [isMobileView]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [currentChatMessages, isTutorThinking]);

  useEffect(() => {
    sendingRef.current = isSendingMessage;
  }, [isSendingMessage]);

  // sesión
  useEffect(() => {
    const loadUser = async () => {
      try {
        const me = await getCurrentUser();
        if (me?.authenticated && me?.user?.id) setUserId(me.user.id);
        else setUserId(null);
      } catch {
        setUserId(null);
      } finally {
        setAuthChecked(true);
      }
    };
    loadUser();
  }, []);

  const ejercicioActual = useMemo(() => {
    return ejerciciosDisponibles.find((e) => e._id === ejercicioActualId) || null;
  }, [ejerciciosDisponibles, ejercicioActualId]);

  const ejerciciosFiltrados = useMemo(() => {
    const q = queryEj.trim().toLowerCase();
    if (!q) return ejerciciosDisponibles;
    return ejerciciosDisponibles.filter((e) => {
      const titulo = (e.titulo || "").toLowerCase();
      const concepto = (e.concepto || "").toLowerCase();
      const nivel = String(e.nivel || "").toLowerCase();
      return titulo.includes(q) || concepto.includes(q) || nivel.includes(q);
    });
  }, [queryEj, ejerciciosDisponibles]);

  // lista de intentos para el ejercicio actual
  const intentosEjercicioActual = useMemo(() => {
    if (!ejercicioActualId) return [];
    const list = (sidebarInteractions || []).filter((it) => it.ejercicioId === ejercicioActualId);
    return [...list].sort((a, b) => {
      const da = a?.fecha ? new Date(a.fecha).getTime() : 0;
      const db = b?.fecha ? new Date(b.fecha).getTime() : 0;
      return db - da;
    });
  }, [sidebarInteractions, ejercicioActualId]);

  const openImageModal = useCallback((imageUrl, imageAlt) => {
    setModalImageUrl(imageUrl);
    setModalImageAlt(imageAlt);
    setShowImageModal(true);
  }, []);

  const closeImageModal = useCallback(() => {
    setShowImageModal(false);
    setModalImageUrl("");
    setModalImageAlt("");
  }, []);

  // resize sidebar
  const startResizing = useCallback(
    (e) => {
      if (isMobileView) return;
      setIsResizing(true);
      e.preventDefault();
    },
    [isMobileView]
  );

  const stopResizing = useCallback(() => setIsResizing(false), []);
  const resizeSidebar = useCallback(
    (e) => {
      if (!isResizing) return;
      const newWidth = e.clientX;
      if (newWidth > 220 && newWidth < 460) setSidebarWidth(newWidth);
    },
    [isResizing]
  );

  useEffect(() => {
    if (isResizing) {
      window.addEventListener("mousemove", resizeSidebar);
      window.addEventListener("mouseup", stopResizing);
    } else {
      window.removeEventListener("mousemove", resizeSidebar);
      window.removeEventListener("mouseup", stopResizing);
    }
    return () => {
      window.removeEventListener("mousemove", resizeSidebar);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [isResizing, resizeSidebar, stopResizing]);

  useEffect(() => {
    localStorage.setItem("sidebarWidth", sidebarWidth.toString());
  }, [sidebarWidth]);

  const fetchSidebarInteractions = useCallback(
    async (ejercicios) => {
      if (!userId) return;
      try {
        const res = await api.get(`/api/interacciones/mine`);
        const lista = Array.isArray(res.data) ? res.data : [];

        const withDetails = lista.map((it) => {
          const ej = ejercicios.find((e) => e._id === it.ejercicio_id);
          return {
            id: it._id,
            ejercicioId: it.ejercicio_id,
            fecha: it.fin || it.inicio || it.updatedAt || it.createdAt || it.fecha || null,
            titulo: ej ? ej.titulo : `Ejercicio desconocido (${it.ejercicio_id})`,
            concepto: ej ? ej.concepto : "Desconocido",
            nivel: ej ? ej.nivel : "—",
          };
        });

        setSidebarInteractions(withDetails);
      } catch (err) {
        console.error("Error cargando sidebar:", err);
        setSidebarInteractions([]);
      }
    },
    [userId]
  );

  const loadInteraccion = useCallback(async (interaccionIdToLoad, ejercicios) => {
    const r = await api.get(`/api/interacciones/${interaccionIdToLoad}`);
    const newInteraccionId = r.data?._id || null;
    const newExerciseId = r.data?.ejercicio_id || null;

    const loadedRaw = Array.isArray(r.data?.conversacion) ? r.data.conversacion : [];
    const loaded = sanitizeConversation(loadedRaw);

    if (newExerciseId && ejercicios.some((e) => e._id === newExerciseId)) {
      setEjercicioActualId(newExerciseId);
    }
    setCurrentInteraccionId(newInteraccionId);
    setCurrentChatMessages(loaded);
  }, []);

  // init
  useEffect(() => {
    const init = async () => {
      try {
        if (!authChecked) return;

        const resEj = await api.get("/api/ejercicios");
        const ejercicios = Array.isArray(resEj.data) ? resEj.data : [];
        setEjerciciosDisponibles(ejercicios);

        const queryParams = new URLSearchParams(location.search);
        const idFromUrl = queryParams.get("id");
        const interaccionIdFromUrl = queryParams.get("interaccionId");

        const interaccionIdLS = localStorage.getItem("currentInteraccionId");
        const ejercicioIdLS = localStorage.getItem("ejercicioActualId");

        if (interaccionIdFromUrl) {
          await loadInteraccion(interaccionIdFromUrl, ejercicios);
          await fetchSidebarInteractions(ejercicios);
          if (isMobileView) setMostrarPanel(false);
          return;
        }

        if (interaccionIdLS) {
          try {
            await loadInteraccion(interaccionIdLS, ejercicios);
          } catch {
            localStorage.removeItem("currentInteraccionId");
          }
        } else {
          let newExerciseId = null;
          if (!newExerciseId && idFromUrl && ejercicios.some((e) => e._id === idFromUrl)) newExerciseId = idFromUrl;
          if (!newExerciseId && ejercicioIdLS && ejercicios.some((e) => e._id === ejercicioIdLS)) newExerciseId = ejercicioIdLS;
          if (!newExerciseId && ejercicios.length) newExerciseId = ejercicios[0]._id;

          setEjercicioActualId(newExerciseId);
          setCurrentInteraccionId(null);
          setCurrentChatMessages([]);
        }

        await fetchSidebarInteractions(ejercicios);
      } catch (err) {
        console.error("Error inicializando Interacciones:", err);
      } finally {
        setLoading(false);
      }
    };

    init();
  }, [authChecked, fetchSidebarInteractions, loadInteraccion, location.search, isMobileView]);

  useEffect(() => {
    if (ejercicioActualId) localStorage.setItem("ejercicioActualId", ejercicioActualId);
  }, [ejercicioActualId]);

  useEffect(() => {
    if (currentInteraccionId) localStorage.setItem("currentInteraccionId", currentInteraccionId);
    else localStorage.removeItem("currentInteraccionId");
  }, [currentInteraccionId]);

  useEffect(() => {
    if (!isMobileView) return;
    const queryParams = new URLSearchParams(location.search);
    const idFromUrl = queryParams.get("id");
    const interaccionIdFromUrl = queryParams.get("interaccionId");
    if (idFromUrl || interaccionIdFromUrl) setMostrarPanel(false);
    else setMostrarPanel(true);
  }, [isMobileView, location.search]);

  const seleccionarInteraccion = useCallback(
    async (it) => {
      if (activeAbortRef.current) {
        try { activeAbortRef.current.abort(); } catch {}
        activeAbortRef.current = null;
      }
      setIsSendingMessage(false);

      setIsTutorThinking(false);
      firstChunkRef.current = false;

      setLoading(true);
      setShowPlusPanel(false);
      try {
        await loadInteraccion(it.id, ejerciciosDisponibles);
        navigate(`/interacciones?id=${it.ejercicioId}&interaccionId=${it.id}`, { replace: true });
        if (isMobileView) setMostrarPanel(false);
      } catch (e) {
        console.error("Error al cargar interacción:", e);
        alert("No se pudo cargar la conversación.");
      } finally {
        setLoading(false);
      }
    },
    [navigate, ejerciciosDisponibles, loadInteraccion, isMobileView]
  );

  const abrirIntento = useCallback(
    async (it) => {
      setShowAttemptsModal(false);
      await seleccionarInteraccion(it);
    },
    [seleccionarInteraccion]
  );

  const borrarInteraccion = useCallback(
    async (id) => {
      if (!window.confirm("¿Eliminar esta interacción? Se borrará permanentemente.")) return;
      try {
        await api.delete(`/api/interacciones/${id}`);
        await fetchSidebarInteractions(ejerciciosDisponibles);

        if (currentInteraccionId === id) {
          setCurrentInteraccionId(null);
          setCurrentChatMessages([]);
          navigate(`/interacciones?id=${ejercicioActualId}`, { replace: true });
        }
      } catch (e) {
        console.error("Error borrando interacción:", e);
        alert("No se pudo eliminar.");
      }
    },
    [currentInteraccionId, ejercicioActualId, ejerciciosDisponibles, fetchSidebarInteractions, navigate]
  );

  const startNewChatWithExercise = useCallback(
    (exerciseId) => {
      if (activeAbortRef.current) {
        try { activeAbortRef.current.abort(); } catch {}
        activeAbortRef.current = null;
      }
      setIsSendingMessage(false);

      setIsTutorThinking(false);
      firstChunkRef.current = false;

      setEjercicioActualId(exerciseId);
      setCurrentInteraccionId(null);
      setCurrentChatMessages([]);
      setNuevoMensaje("");
      setShowPlusPanel(false);
      setQueryEj("");
      navigate(`/interacciones?id=${exerciseId}`, { replace: true });
      if (isMobileView) setMostrarPanel(false);
    },
    [navigate, isMobileView]
  );

  // reintentar mismo ejercicio
  const startNewAttemptSameExercise = useCallback(() => {
    if (!ejercicioActualId) return;

    if (activeAbortRef.current) {
      try { activeAbortRef.current.abort(); } catch {}
      activeAbortRef.current = null;
    }

    setIsSendingMessage(false);
    setIsTutorThinking(false);
    firstChunkRef.current = false;

    setCurrentInteraccionId(null);
    setCurrentChatMessages([]);
    setNuevoMensaje("");

    localStorage.removeItem("currentInteraccionId");
    navigate(`/interacciones?id=${ejercicioActualId}`, { replace: true });
  }, [ejercicioActualId, navigate]);

  // ✅ guarda resultados cuando llega FIN
  const finalizarResultado = useCallback(
    async ({ exerciseId, interaccionId, resueltoALaPrimera }) => {
      if (!userId || !exerciseId || !interaccionId) return;

      try {
        await api.post("/api/resultados/finalizar", {
          // userId is derived from session on the server (NOT sent from client)
          exerciseId,
          interaccionId,
          resueltoALaPrimera,
        });
      } catch (e) {
        console.error("[FINALIZAR RESULTADO] Error:", e?.response?.data || e?.message || e);
      }
    },
    [userId]
  );

  const enviarMensaje = useCallback(async () => {
    const ej = ejerciciosDisponibles.find((e) => e._id === ejercicioActualId);
    const texto = nuevoMensaje.trim();
    if (!texto || !ej) return;
    if (sendingRef.current) return;

    // bloquea INMEDIATAMENTE
    sendingRef.current = true;
    setIsSendingMessage(true);

    // ✅ si no hay sesión, NO te quedes bloqueada
    if (!userId) {
      alert("No hay sesión iniciada. Vuelve a Login.");
      setIsSendingMessage(false);
      sendingRef.current = false;
      setIsTutorThinking(false);
      firstChunkRef.current = false;
      return;
    }

    if (activeAbortRef.current) {
      try { activeAbortRef.current.abort(); } catch {}
      activeAbortRef.current = null;
    }

    setNuevoMensaje("");

    setIsTutorThinking(true);
    firstChunkRef.current = false;
    finHandledRef.current = false;

    setCurrentChatMessages((prev) => [
      ...prev,
      { role: "user", content: texto },
      { role: "assistant", content: "" },
    ]);

    let acc = "";
    let newIdFromServer = null;
    let done = false;
    let finDetected = false;

    const ctrl = new AbortController();
    activeAbortRef.current = ctrl;

    let lastDataAt = Date.now();
    const watchdog = setInterval(() => {
      if (done) return;
      if (Date.now() - lastDataAt > 300000) {
        try { ctrl.abort(); } catch {}
      }
    }, 5000);

    try {
      await enviarMensajeStream({
        payload: {
          // userId is derived from session on the server (NOT sent from client)
          exerciseId: ej._id,
          interaccionId: currentInteraccionId || undefined,
          llmMode: "upv",
          userMessage: texto,
        },
        signal: ctrl.signal,

        onInteraccionId: (id) => {
          newIdFromServer = id;
          interaccionIdRef.current = id;
          setCurrentInteraccionId(id);
        },

        onChunk: (piece) => {
          lastDataAt = Date.now();

          if (!firstChunkRef.current) {
            firstChunkRef.current = true;
            setIsTutorThinking(false);
          }

          acc += piece;

          // ✅ Detectar FIN una sola vez
          if (!finHandledRef.current && containsFinishToken(acc)) {
            finHandledRef.current = true;
            finDetected = true;

            const iid = newIdFromServer || interaccionIdRef.current;
            if (iid) {
              const userCount = (currentChatMessagesRef.current || []).filter((m) => m.role === "user").length;
              const firstTry = userCount <= 1;

              finalizarResultado({
                exerciseId: ej._id,
                interaccionId: iid,
                resueltoALaPrimera: firstTry,
              });
            } else {
              console.warn("[FIN] token detectado pero aún no hay interaccionId; se intentará en onDone.");
            }
          }

          setCurrentChatMessages((prev) => {
            const copy = [...prev];
            const last = copy.length - 1;
            if (copy[last]?.role === "assistant") {
              copy[last] = {
                ...copy[last],
                content: stripFinishTokenStreaming(acc),
              };
            }
            return copy;
          });
        },

        onDone: async () => {
          done = true;
          clearInterval(watchdog);

          setIsTutorThinking(false);
          firstChunkRef.current = false;

          // ✅ Backup: si el FIN llegó antes de tener interaccionId, finaliza aquí
          if (finDetected) {
            const iid = newIdFromServer || interaccionIdRef.current;
            if (iid) {
              const userCount = (currentChatMessagesRef.current || []).filter((m) => m.role === "user").length;
              const firstTry = userCount <= 1;

              await finalizarResultado({
                exerciseId: ej._id,
                interaccionId: iid,
                resueltoALaPrimera: firstTry,
              });
            }
          }

          await fetchSidebarInteractions(ejerciciosDisponibles);
        },

        onError: (err) => {
          if (err?.name === "AbortError") return;
          done = true;
          clearInterval(watchdog);

          setIsTutorThinking(false);
          firstChunkRef.current = false;

          setCurrentChatMessages((prev) => [
            ...prev,
            { role: "assistant", content: "Error: No se pudo conectar con el tutor." },
          ]);
        },
      });
    } finally {
      clearInterval(watchdog);
      activeAbortRef.current = null;
      setIsSendingMessage(false);
      sendingRef.current = false;
      setIsTutorThinking(false);
      firstChunkRef.current = false;
    }
  }, [
    ejerciciosDisponibles,
    ejercicioActualId,
    nuevoMensaje,
    currentInteraccionId,
    userId,
    fetchSidebarInteractions,
    finalizarResultado,
  ]);

  // ===== Render =====
  if (!authChecked) {
    return (
      <div className="interacciones-cargando">
        <p>Comprobando sesión…</p>
      </div>
    );
  }

  if (!userId) {
    return (
      <div className="interacciones-cargando">
        <p>No hay sesión iniciada.</p>
        <p>Vuelve a Login.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="interacciones-cargando">
        <p>Cargando ejercicios e historial…</p>
      </div>
    );
  }

  if (ejerciciosDisponibles.length === 0) {
    return (
      <div className="interacciones-cargando">
        <p>No hay ejercicios disponibles. Revisa el backend y la colección de ejercicios.</p>
      </div>
    );
  }

  if (!ejercicioActualId || !ejercicioActual) {
    return (
      <div className="interacciones-cargando">
        <p>No se ha podido cargar el ejercicio actual.</p>
      </div>
    );
  }

  const basePath = import.meta.env.VITE_BASE_PATH || "";
  const imgSrc = ejercicioActual.imagen ? `${basePath}/static/${ejercicioActual.imagen}` : `${basePath}/placeholder-ejercicio.png`;

  return (
    <div className="interacciones-scope">
      {mostrarPanel && (
        <aside className="interacciones-sidebar" style={{ width: isMobileView ? "100%" : `${sidebarWidth}px` }}>
          <div className="interacciones-sidebar-header">
            <h2 className="interacciones-sidebar-title">Chats</h2>

            <div className="sidebar-actions">
              {isMobileView && (
                <button className="btn-icon" title="Volver al chat" onClick={() => setMostrarPanel(false)} type="button">
                  <XMarkIcon className="h-5 w-5" />
                </button>
              )}

              <button
                className="btn-icon"
                title={showPlusPanel ? "Cerrar Nuevo chat" : "Nuevo chat"}
                onClick={() => {
                  setShowPlusPanel((v) => !v);
                  setQueryEj("");
                }}
                type="button"
              >
                ＋
              </button>
            </div>
          </div>

          {showPlusPanel && (
            <div className="plus-panel">
              <div className="plus-panel-header">
                <h3 className="plus-panel-title">Nuevo chat</h3>
                <button
                  className="plus-panel-close"
                  title="Cerrar"
                  onClick={() => {
                    setShowPlusPanel(false);
                    setQueryEj("");
                  }}
                  type="button"
                >
                  ✕
                </button>
              </div>

              <input
                className="plus-search"
                type="text"
                value={queryEj}
                onChange={(e) => setQueryEj(e.target.value)}
                placeholder="Buscar ejercicio…"
              />

              <div className="plus-list">
                {ejerciciosFiltrados.length > 0 ? (
                  ejerciciosFiltrados.map((e) => (
                    <div
                      key={e._id}
                      className="plus-item"
                      onClick={() => startNewChatWithExercise(e._id)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="plus-item-title">{e.titulo}</div>
                      <div className="plus-item-meta">
                        {e.concepto} · Nivel {e.nivel}
                        <span className="plus-item-pill">N{e.nivel}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="plus-empty">No hay ejercicios que coincidan.</div>
                )}
              </div>
            </div>
          )}

          <div className="sidebar-list">
            {sidebarInteractions.length > 0 ? (
              sidebarInteractions.map((i) => (
                <div
                  key={i.id}
                  className={`sidebar-item ${i.id === currentInteraccionId ? "sidebar-item-active" : ""}`}
                  onClick={() => seleccionarInteraccion(i)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="sidebar-item-content">
                    <div className="sidebar-item-title">{i.titulo}</div>
                    <div className="sidebar-item-sub">
                      {i.concepto} · Nivel {i.nivel}
                    </div>
                  </div>

                  <button
                    className="sidebar-item-trash"
                    title="Eliminar interacción"
                    onClick={(e) => {
                      e.stopPropagation();
                      borrarInteraccion(i.id);
                    }}
                    type="button"
                  >
                    <TrashIcon className="h-5 w-5" />
                  </button>
                </div>
              ))
            ) : (
              <div className="sidebar-empty">No hay interacciones guardadas. Pulsa “＋” para empezar.</div>
            )}
          </div>

          {!isMobileView && <div className="sidebar-resizer" onMouseDown={startResizing} />}
        </aside>
      )}

      <main className="chat-wrap">
        <div className="chat-top">
          {isMobileView && !mostrarPanel && (
            <button className="mobile-open-chats" onClick={() => setMostrarPanel(true)} title="Ver chats" type="button">
              Chats
            </button>
          )}

          <img
            src={imgSrc}
            alt={ejercicioActual.titulo || "Ejercicio"}
            className="chat-top-img"
            onClick={() => openImageModal(imgSrc, ejercicioActual.titulo || "Ejercicio")}
          />

          <div className="chat-top-text" style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 className="chat-top-title" style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {ejercicioActual.titulo}
                </span>

                <button
                  type="button"
                  onClick={() => setShowAttemptsModal(true)}
                  style={{
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    cursor: "pointer",
                    fontSize: "0.86rem",
                    color: "var(--color-text-muted)",
                    textDecoration: "underline",
                    whiteSpace: "nowrap",
                  }}
                  title="Ver intentos anteriores"
                >
                  Ver intentos ({intentosEjercicioActual.length})
                </button>

                <button
                  type="button"
                  onClick={startNewAttemptSameExercise}
                  title="Reintentar este ejercicio"
                  style={{
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg-surface)",
                    borderRadius: 9999,
                    padding: "0.15rem 0.55rem",
                    cursor: "pointer",
                    fontSize: "0.9rem",
                    whiteSpace: "nowrap",
                  }}
                >
                  ↻
                </button>
              </h3>

              <p className="chat-top-enunciado">{ejercicioActual.enunciado}</p>
            </div>
          </div>
        </div>

        <div className="chat-body">
          <div ref={scrollRef} className="chat-messages">
            {currentChatMessages.length > 0 ? (
              currentChatMessages.map((m, i) => (
                <div key={i} className={`msg ${m.role === "user" ? "msg-user" : "msg-assistant"}`}>
                  {m.role === "user"
                    ? m.content
                    : <MessageRenderer content={m.content} />}
                </div>
              ))
            ) : (
              <p className="chat-empty">No hay mensajes aún. Escribe el primero para empezar.</p>
            )}

            {isTutorThinking && (
              <div className="msg msg-assistant" style={{ opacity: 0.75, display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 9999,
                    background: "currentColor",
                    opacity: 0.55,
                    animation: "pulse 1.2s ease-in-out infinite",
                  }}
                />
                <span style={{ fontSize: "0.95em", color: "var(--color-text-muted)" }}>El tutor está pensando…</span>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              enviarMensaje();
            }}
            className="chat-inputbar"
          >
            <input
              type="text"
              value={nuevoMensaje}
              onChange={(e) => setNuevoMensaje(e.target.value)}
              placeholder="Escribe tu mensaje…"
              className="chat-text"
              disabled={isSendingMessage || !ejercicioActualId}
            />

            <button
              type="submit"
              className="btn-secondary chat-send"
              disabled={isSendingMessage || !nuevoMensaje.trim() || !ejercicioActualId}
            >
              Enviar
            </button>
          </form>
        </div>
      </main>

      {/* Modal intentos */}
      {showAttemptsModal && (
        <div
          className="img-modal-backdrop"
          onClick={() => setShowAttemptsModal(false)}
          style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(560px, 92vw)",
              maxHeight: "80vh",
              overflow: "auto",
              background: "var(--color-bg-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "16px",
              padding: "1rem",
              boxShadow: "0 12px 30px rgba(0,0,0,0.18)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: "1.05rem" }}>Intentos anteriores</div>
                <div style={{ color: "var(--color-text-muted)", fontSize: "0.9rem", marginTop: 2 }}>
                  {ejercicioActual?.titulo}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowAttemptsModal(false)}
                style={{ border: "none", background: "transparent", cursor: "pointer", padding: 6 }}
                title="Cerrar"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <div style={{ height: 1, background: "var(--color-border)", margin: "0.85rem 0" }} />

            {intentosEjercicioActual.length === 0 ? (
              <div style={{ color: "var(--color-text-muted)" }}>
                Aún no hay intentos guardados para este ejercicio.
              </div>
            ) : (
              <div style={{ display: "grid", gap: "0.55rem" }}>
                {intentosEjercicioActual.map((it, idx) => {
                  const fechaTxt = safeDateLabel(it.fecha);
                  const label = `Intento ${intentosEjercicioActual.length - idx}${fechaTxt ? ` · ${fechaTxt}` : ""}`;

                  return (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => abrirIntento(it)}
                      style={{
                        textAlign: "left",
                        width: "100%",
                        border: "1px solid var(--color-border)",
                        background: "rgba(0,0,0,0.02)",
                        borderRadius: "12px",
                        padding: "0.75rem 0.85rem",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 800 }}>{label}</div>
                      <div style={{ color: "var(--color-text-muted)", fontSize: "0.92rem", marginTop: 2 }}>
                        {it.concepto} · Nivel {it.nivel}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <div style={{ height: 1, background: "var(--color-border)", margin: "0.85rem 0" }} />

            <button
              type="button"
              onClick={() => {
                setShowAttemptsModal(false);
                startNewAttemptSameExercise();
              }}
              style={{
                border: "1px solid var(--color-border)",
                background: "var(--color-bg-surface)",
                borderRadius: 9999,
                padding: "0.55rem 0.9rem",
                cursor: "pointer",
                fontWeight: 700,
              }}
              title="Crear un nuevo intento"
            >
              ↻ Crear nuevo intento
            </button>
          </div>
        </div>
      )}

      {showImageModal && (
        <div className="img-modal-backdrop" onClick={closeImageModal}>
          <div className="img-modal" onClick={(e) => e.stopPropagation()}>
            <button className="img-modal-close" onClick={closeImageModal} title="Cerrar" type="button">
              <XMarkIcon className="h-6 w-6" />
            </button>
            <img src={modalImageUrl} alt={modalImageAlt} />
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: .35; }
          50% { transform: scale(1.15); opacity: .75; }
        }
      `}</style>
    </div>
  );
}
