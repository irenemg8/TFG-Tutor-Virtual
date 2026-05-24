import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer
} from "recharts";
import {
  CalendarDaysIcon,
  ExclamationTriangleIcon,
  ArrowRightIcon
} from "@heroicons/react/24/outline";
import { useNavigate } from "react-router-dom";
import { getCurrentUser } from "../services/auth";

const initialState = {
  resumenSemanal: {
    ejerciciosCompletados: 0,
    conceptosDistintos: 0,
    rachaDias: 0
  },
  eficienciaPorConcepto: [],
  ultimaSesion: {
    tituloEjercicio: "",
    analisis: "Completa un ejercicio para ver aquí tu resumen.",
    consejo: "¡Mucho ánimo!"
  },
  erroresFrecuentes: [],
  recomendacion: {
    titulo: "",
    motivo: "Haz un ejercicio para que el tutor pueda recomendarte una práctica personalizada.",
    ejercicioId: null,
    concepto: ""
  }
};

// =========================
// DEMO (DESACTIVADO)
// =========================
// const DEMO_KEY = "tv_demo_enabled";

// const demoData = {
//   resumenSemanal: {
//     ejerciciosCompletados: 6,
//     conceptosDistintos: 3,
//     rachaDias: 4
//   },
//   eficienciaPorConcepto: [
//     { concepto: "Ley de Ohm", interacciones: 6 },
//     { concepto: "Potencia eléctrica", interacciones: 5 },
//     { concepto: "Serie / paralelo", interacciones: 4 },
//     { concepto: "Divisor de tensión", interacciones: 3 }
//   ],
//   ultimaSesion: {
//     tituloEjercicio: "Ejercicio 12 · Resistencias en serie",
//     analisis:
//       "Has planteado bien la relación V = I·R, pero te ha costado identificar qué resistencia equivalente usar.",
//     consejo:
//       "Antes de calcular I, escribe R_eq y justifica si es suma (serie) o inversa (paralelo)."
//   },
//   erroresFrecuentes: [
//     { etiqueta: "CA_OHM_01", texto: "Confunde tensión (V) e intensidad (I)", veces: 3 },
//     { etiqueta: "CA_SERPAR_02", texto: "Aplica mal la resistencia equivalente", veces: 2 },
//     { etiqueta: "CA_UNITS_01", texto: "Olvida unidades o prefijos (mA, kΩ)", veces: 2 }
//   ],
//   recomendacion: {
//     titulo: "Refuerza: Resistencia equivalente en serie/paralelo",
//     motivo:
//       "En tus últimas interacciones se repite un error al combinar resistencias. Practica un ejercicio corto guiado.",
//     ejercicioId: "DEMO_EJ_001",
//     concepto: "Serie / paralelo"
//   }
// };

// Merge profundo + saneo de tipos
function mergeDashboardData(apiData) {
  const d = apiData || {};

  const eficienciaPorConcepto = Array.isArray(d.eficienciaPorConcepto)
    ? d.eficienciaPorConcepto
        .filter((x) => x && typeof x.concepto === "string")
        .map((x) => ({
          concepto: x.concepto,
          interacciones: Number(x.interacciones) || 0
        }))
    : initialState.eficienciaPorConcepto;

  const erroresFrecuentes = Array.isArray(d.erroresFrecuentes)
    ? d.erroresFrecuentes
        .filter((e) => e && (e.etiqueta || e.texto))
        .map((e) => ({
          etiqueta: e.etiqueta || "",
          texto: e.texto || e.etiqueta || "Error",
          veces: Number(e.veces) || 0
        }))
    : initialState.erroresFrecuentes;

  return {
    ...initialState,
    ...d,
    resumenSemanal: {
      ...initialState.resumenSemanal,
      ...(d.resumenSemanal || {})
    },
    ultimaSesion: {
      ...initialState.ultimaSesion,
      ...(d.ultimaSesion || {})
    },
    recomendacion: {
      ...initialState.recomendacion,
      ...(d.recomendacion || {})
    },
    eficienciaPorConcepto,
    erroresFrecuentes
  };
}

export default function Dashboard() {
  // =========================
  // DEMO (DESACTIVADO)
  // =========================
  // const initialIsDemo = localStorage.getItem(DEMO_KEY) === "true";
  // const [isDemo] = useState(initialIsDemo);

  // ✅ SOLO REAL
  const isDemo = false;

  const [data, setData] = useState(initialState);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const navigate = useNavigate();

  const BACKEND = import.meta.env.VITE_BACKEND_URL;

  const backendBase = useMemo(() => {
    if (!BACKEND) return "";
    return String(BACKEND).replace(/\/+$/, "");
  }, [BACKEND]);

  useEffect(() => {
    let ignore = false;
    setLoadError(null);

    // =========================
    // DEMO (DESACTIVADO)
    // =========================
    // if (isDemo) {
    //   setData(mergeDashboardData(demoData));
    //   setLoading(false);
    //   return () => { ignore = true; };
    // }

    if (!backendBase) {
      setData(initialState);
      setLoading(false);
      setLoadError("No está configurado VITE_BACKEND_URL.");
      return () => { ignore = true; };
    }

    const run = async () => {
      try {
        setLoading(true);

        // 1) Usuario real
        const me = await getCurrentUser();
        const uid = me?.authenticated && me?.user?.id ? me.user.id : null;

        if (!uid) {
          if (!ignore) {
            setData(initialState);
            setLoadError("No hay sesión iniciada.");
          }
          return;
        }

        // 2) Progreso real (userId from session, not URL)
        const res = await axios.get(`${backendBase}/api/progreso`, {
          withCredentials: true,
          timeout: 12000
        });

        if (ignore) return;

        // =========================
        // DEMO (DESACTIVADO)
        // =========================
        // if (localStorage.getItem(DEMO_KEY) === "true") return;

        setData(mergeDashboardData(res.data));
      } catch (error) {
        if (ignore) return;

        // =========================
        // DEMO (DESACTIVADO)
        // =========================
        // if (localStorage.getItem(DEMO_KEY) === "true") return;

        console.error("Error al cargar los datos del progreso:", error);
        setData(initialState);

        const msg =
          error?.code === "ECONNABORTED"
            ? "Tiempo de espera agotado al consultar el progreso."
            : error?.response
              ? `Error ${error.response.status} al consultar el progreso.`
              : "No se pudo conectar con el backend para cargar el progreso.";

        setLoadError(msg);
      } finally {
        if (ignore) return;

        // =========================
        // DEMO (DESACTIVADO)
        // =========================
        // if (localStorage.getItem(DEMO_KEY) === "true") return;

        setLoading(false);
      }
    };

    run();

    return () => { ignore = true; };
  }, [backendBase, isDemo]);

  const hasChartData = (data.eficienciaPorConcepto || []).length > 0;
  const hasErrores = (data.erroresFrecuentes || []).length > 0;

  const chartTitle = "Dificultad estimada por concepto";
  const chartHelp =
    "Aproximación basada en el número medio de mensajes necesarios para resolver ejercicios. Úsalo como señal de qué reforzar, no como nota.";

  const handlePracticar = () => {
    localStorage.removeItem("currentInteraccionId");
    localStorage.removeItem("ejercicioActualId");

    const recId = data?.recomendacion?.ejercicioId;

    // ✅ Interacciones.jsx lee queryParams.get("id")
    if (recId) {
      navigate(`/interacciones?id=${encodeURIComponent(recId)}`, { replace: true });
      return;
    }
    navigate("/ejercicios", { replace: true });
  };

  if (loading) {
    return <div className="dashboard-loading">Cargando tu progreso...</div>;
  }

  return (
    <div className="dashboard-scope">
      <header className="dashboard-header container-app">
        <h1 className="dashboard-title">Tu Progreso</h1>
        <div className="dashboard-acento" />

        {!isDemo && loadError && (
          <div className="dashboard-demo-badge" style={{ borderLeftColor: "var(--color-primary)" }}>
            No se ha podido cargar tu progreso real. Mostrando valores por defecto. <br />
            <span style={{ opacity: 0.85 }}>{loadError}</span>
          </div>
        )}

        <p className="dashboard-subtitle">
          Actividad semanal, conceptos que te cuestan más y una recomendación clara para tu próxima sesión.
        </p>
      </header>

      <main className="dashboard-main container-app">
        {/* FILA 1 */}
        <section className="dashboard-grid dashboard-grid-top">
          <article className="card dashboard-card dashboard-card-wide">
            <h2 className="dashboard-card-title">
              <CalendarDaysIcon className="dashboard-icon" />
              Actividad (últimos 7 días)
            </h2>

            <div className="dashboard-metrics">
              <div className="dashboard-metric">
                <span className="dashboard-metric-value">
                  {data.resumenSemanal.ejerciciosCompletados}
                </span>
                <span className="dashboard-metric-label">Ejercicios completados</span>
              </div>

              <div className="dashboard-divider" />

              <div className="dashboard-metric">
                <span className="dashboard-metric-value">
                  {data.resumenSemanal.conceptosDistintos}
                </span>
                <span className="dashboard-metric-label">Conceptos practicados</span>
              </div>

              <div className="dashboard-divider" />

              <div className="dashboard-metric">
                <span className="dashboard-metric-value dashboard-streak">
                  {data.resumenSemanal.rachaDias}
                </span>
                <span className="dashboard-metric-label">Días de racha</span>
              </div>
            </div>
          </article>

          <article className="card dashboard-card dashboard-card-center">
            <h2 className="dashboard-card-title">Recomendación para tu próxima sesión</h2>

            <p className="dashboard-help" style={{ marginTop: "-0.25rem" }}>
              {data.recomendacion?.titulo ? (
                <>
                  <strong>{data.recomendacion.titulo}</strong>
                  {data.recomendacion.concepto ? (
                    <span style={{ color: "var(--color-text-muted)" }}>
                      {" "}
                      · {data.recomendacion.concepto}
                    </span>
                  ) : null}
                </>
              ) : (
                <strong>Sin recomendación aún</strong>
              )}
            </p>

            <p className="dashboard-help">{data.recomendacion?.motivo}</p>

            <button
              type="button"
              className="btn-secondary"
              onClick={handlePracticar}
              style={{ borderRadius: 9999, marginTop: "0.75rem" }}
            >
              Practicar ahora <ArrowRightIcon style={{ width: 18, height: 18 }} />
            </button>
          </article>
        </section>

        {/* FILA 2 */}
        <section className="dashboard-grid dashboard-grid-bottom">
          <article className="card dashboard-card">
            <h2 className="dashboard-card-title">{chartTitle}</h2>
            <p className="dashboard-help">{chartHelp}</p>

            <div className="dashboard-chart">
              {hasChartData ? (
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart
                    data={data.eficienciaPorConcepto}
                    layout="vertical"
                    margin={{ top: 8, right: 16, left: 16, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" allowDecimals />
                    <YAxis type="category" dataKey="concepto" width={140} tick={{ fontSize: 10 }} />
                    <Tooltip
                      formatter={(value) => [`${Number(value).toFixed(1)}`, "Mensajes medios"]}
                      cursor={{ fill: "rgba(231,38,33,0.06)" }}
                      contentStyle={{
                        backgroundColor: "var(--color-bg-surface)",
                        border: "1px solid var(--color-border)",
                        borderRadius: "12px"
                      }}
                    />
                    <Bar
                      dataKey="interacciones"
                      name="Mensajes medios"
                      fill="var(--color-primary)"
                      barSize={18}
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="dashboard-empty">No hay datos suficientes para mostrar el gráfico.</div>
              )}
            </div>
          </article>

          <article className="card dashboard-card">
            <h2 className="dashboard-card-title">
              <ExclamationTriangleIcon className="dashboard-icon" />
              En qué te estás equivocando más
            </h2>

            {hasErrores ? (
              <div style={{ display: "grid", gap: "0.6rem" }}>
                {(data.erroresFrecuentes || []).slice(0, 3).map((e, idx) => (
                  <div
                    key={e.etiqueta || idx}
                    style={{
                      border: "1px solid var(--color-border)",
                      borderRadius: "var(--radius-md)",
                      padding: "0.85rem 0.9rem",
                      background: "rgba(0,0,0,0.02)"
                    }}
                  >
                    <div style={{ fontWeight: 700 }}>{e.texto}</div>
                    <div style={{ color: "var(--color-text-muted)", marginTop: 4, fontSize: "0.92rem" }}>
                      Detectado {e.veces} vez/veces recientemente.
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="dashboard-empty">
                Cuando completes ejercicios, aquí verás patrones de error y concepciones alternativas frecuentes.
              </div>
            )}

            <div style={{ height: 1, background: "var(--color-border)", margin: "1rem 0" }} />

            <h3 className="dashboard-last-title" style={{ marginBottom: 6 }}>
              Resumen de la última sesión
            </h3>

            <div className="dashboard-last">
              <h4 className="dashboard-last-title">
                {data.ultimaSesion.tituloEjercicio || "Aún no hay sesión registrada"}
              </h4>

              <p className="dashboard-last-text">{data.ultimaSesion.analisis}</p>

              <p className="dashboard-last-advice">
                <span>Consejo del tutor:</span> {data.ultimaSesion.consejo}
              </p>
            </div>
          </article>
        </section>
      </main>
    </div>
  );
}
