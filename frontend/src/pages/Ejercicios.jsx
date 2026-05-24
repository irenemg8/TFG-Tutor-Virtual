// frontend/src/pages/Ejercicios.jsx
import { useLocation, useNavigate } from "react-router-dom";
import { useMemo, useEffect, useState, useCallback, useRef } from "react";

import { Disclosure, DisclosureButton, DisclosurePanel } from "@headlessui/react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  MagnifyingGlassIcon,
  CheckIcon,
} from "@heroicons/react/20/solid";

import { api } from "../services/api";
import { getCurrentUser } from "../services/auth";

function classNames(...classes) {
  return classes.filter(Boolean).join(" ");
}

const LOCAL_STORAGE_FILTERS_KEY = "ejerciciosPageFilters";

export default function EjerciciosPage() {
  const { search } = useLocation();
  const navigate = useNavigate();

  const [loadingEjercicios, setLoadingEjercicios] = useState(true);
  const [errorEjercicios, setErrorEjercicios] = useState(null);

  const [allEjercicios, setAllEjercicios] = useState([]);
  const [completedIds, setCompletedIds] = useState(new Set());

  const [userId, setUserId] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  // Filtros
  const [asig, setAsig] = useState("");
  const [conceptosSeleccionados, setConceptosSeleccionados] = useState([]);
  const [nivel, setNivel] = useState(0);

  const opcionesAsignaturas = ["Dispositivos electrónicos", "Teoría de circuitos"];
  const conceptosPorAsignatura = {
    "Dispositivos electrónicos": ["Ley de Ohm", "Polarización", "Semiconductores"],
    "Teoría de circuitos": ["Norton", "Thevenin"],
  };

  const conceptosDisponibles = useMemo(() => {
    return asig ? conceptosPorAsignatura[asig] || [] : [];
  }, [asig]);

  const isInitialMount = useRef(true);

  // 1) Cargar sesión (userId real)
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

  // Helper: normaliza IDs a string para comparar bien en Set
  const normalizeId = (x) => {
    if (!x) return null;
    if (typeof x === "string" || typeof x === "number") return String(x);
    if (x?._id) return String(x._id);
    if (x?.ejercicio_id) return String(x.ejercicio_id);
    return null;
  };

  // 2) Cargar ejercicios + completados del usuario real (sin romper si completados falla)
  useEffect(() => {
    const ctrl = new AbortController();

    const fetchData = async () => {
      setLoadingEjercicios(true);
      setErrorEjercicios(null);

      try {
        // A) Ejercicios (esto sí es crítico)
        const ejerciciosRes = await api.get("/api/ejercicios", { signal: ctrl.signal });
        const ejerciciosRaw = Array.isArray(ejerciciosRes.data) ? ejerciciosRes.data : [];

        const ejerciciosLimpios = ejerciciosRaw.map((ej) => ({
          ...ej,
          nivel: parseInt(ej.nivel, 10) || 0,
        }));

        setAllEjercicios(ejerciciosLimpios);

        // B) Completados (no crítico, pero necesario para el tick)
        if (!userId) {
          setCompletedIds(new Set());
          return;
        }

        // userId from session on server (not sent from client)
        let completedData = null;
        try {
          const r = await api.get(`/api/resultados/completed`, { signal: ctrl.signal });
          completedData = r.data;
        } catch (e) {
          // Endpoint failed -> no ticks, but screen still works
          setCompletedIds(new Set());
          return;
        }

        const raw = Array.isArray(completedData) ? completedData : [];
        const normalized = raw.map(normalizeId).filter(Boolean);
        setCompletedIds(new Set(normalized));
      } catch (err) {
        console.error("Error al obtener ejercicios:", err);
        setErrorEjercicios("No se pudieron cargar los ejercicios. Revisa consola y rutas /api.");
        setAllEjercicios([]);
        setCompletedIds(new Set());
      } finally {
        setLoadingEjercicios(false);
      }
    };

    if (!authChecked) return;
    fetchData();

    return () => ctrl.abort();
  }, [authChecked, userId]);

  // Sin sesión -> no bloqueamos ejercicios, pero avisamos
  // (si quieres bloquearlo, dímelo y lo cambio)
  const showNoSession = authChecked && !userId;

  useEffect(() => {
    const queryParams = new URLSearchParams(search);
    let loadedAsig = queryParams.get("asig") || "";
    let loadedConceptosRaw = queryParams.get("conceptos");
    let loadedNivel = parseInt(queryParams.get("nivel"), 10) || 0;

    if (!isInitialMount.current && asig !== loadedAsig) {
      setConceptosSeleccionados([]);
    }

    setAsig(loadedAsig);

    if (loadedConceptosRaw) {
      const validConcepts = conceptosPorAsignatura[loadedAsig] || [];
      setConceptosSeleccionados(
        loadedConceptosRaw.split(",").filter((c) => validConcepts.includes(c))
      );
    } else if (isInitialMount.current === false) {
      setConceptosSeleccionados([]);
    }

    setNivel(loadedNivel);

    if (isInitialMount.current) {
      isInitialMount.current = false;
    }
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleConcepto = (c) => {
    setConceptosSeleccionados((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
    );
  };

  const aplicarFiltros = useCallback(() => {
    const query = new URLSearchParams();
    const currentFilters = { asig, conceptos: conceptosSeleccionados, nivel };

    if (asig) query.set("asig", asig);
    if (conceptosSeleccionados.length > 0)
      query.set("conceptos", conceptosSeleccionados.join(","));
    if (nivel > 0) query.set("nivel", nivel.toString());

    localStorage.setItem(LOCAL_STORAGE_FILTERS_KEY, JSON.stringify(currentFilters));
    navigate(`/ejercicios?${query.toString()}`);
  }, [asig, conceptosSeleccionados, nivel, navigate]);

  const limpiarFiltros = useCallback(() => {
    setAsig("");
    setConceptosSeleccionados([]);
    setNivel(0);
    localStorage.removeItem(LOCAL_STORAGE_FILTERS_KEY);
    navigate("/ejercicios");
  }, [navigate]);

  const ejerciciosFiltrados = useMemo(() => {
    const CONCEPT_ORDER = ["Ley de Ohm", "Semiconductores", "Polarización", "Norton", "Thevenin"];
    const conceptRank = (c) => {
      const i = CONCEPT_ORDER.indexOf(c);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const extractExerciseNumber = (titulo) => {
      const match = typeof titulo === "string" ? titulo.match(/\d+/) : null;
      return match ? parseInt(match[0], 10) : Number.MAX_SAFE_INTEGER;
    };

    const filtered = allEjercicios.filter((ejercicio) => {
      if (asig && ejercicio.asignatura !== asig) return false;
      if (
        conceptosSeleccionados.length > 0 &&
        !conceptosSeleccionados.includes(ejercicio.concepto)
      )
        return false;
      if (nivel > 0 && ejercicio.nivel != nivel) return false;
      return true;
    });

    return filtered.sort((a, b) => {
      const ca = conceptRank(a.concepto) - conceptRank(b.concepto);
      if (ca !== 0) return ca;
      const na = extractExerciseNumber(a.titulo);
      const nb = extractExerciseNumber(b.titulo);
      if (na !== nb) return na - nb;
      return (a.nivel || 0) - (b.nivel || 0);
    });
  }, [allEjercicios, asig, conceptosSeleccionados, nivel]);

  const filtrosActivos = useMemo(
    () => asig !== "" || conceptosSeleccionados.length > 0 || nivel > 0,
    [asig, conceptosSeleccionados, nivel]
  );

  const handleRowClick = useCallback(
    (ejercicioId) => navigate(`/interacciones?id=${ejercicioId}`),
    [navigate]
  );

  return (
    <div className="busqueda ejercicios-scope">
      <h2 className="titulo centrado text-2xl font-semibold mb-6">
        {filtrosActivos ? "Ejercicios filtrados" : "Todos los ejercicios"}
      </h2>

      {showNoSession && (
        <div className="mensaje-vacio text-center p-3 text-gray-600 mb-4">
          <p>No hay sesión iniciada. Inicia sesión para ver tus ejercicios completados (ticks).</p>
        </div>
      )}

      {/* FILTROS */}
      <Disclosure
        as="div"
        className="bg-white shadow-lg rounded-xl max-w-xl mx-auto mt-5 p-6 mb-10 border border-gray-200"
      >
        {({ open }) => (
          <>
            <DisclosureButton
              className={classNames(
                "flex justify-between items-center w-full text-xl font-semibold text-azuloscuro mb-4 pb-2 border-b border-gray-200",
                filtrosActivos ? "text-rojo" : "hover:text-rojo"
              )}
            >
              <span>
                <MagnifyingGlassIcon className="h-6 w-6 inline-block mr-2" />
                Filtrar
              </span>
              {open ? (
                <ChevronUpIcon className="h-6 w-6 text-gray-500" />
              ) : (
                <ChevronDownIcon className="h-6 w-6 text-gray-500" />
              )}
            </DisclosureButton>

            <DisclosurePanel className="pt-2">
              <div className="mb-4">
                <label className="block font-medium mb-2 text-dark">Asignatura</label>
                <select
                  className="w-full p-2 rounded border border-gray-300"
                  value={asig}
                  onChange={(e) => setAsig(e.target.value)}
                >
                  <option value="">Todas las asignaturas</option>
                  {opcionesAsignaturas.map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mb-4">
                <label className="block font-medium mb-2 text-dark">Conceptos</label>
                <div className="flex flex-wrap gap-4 justify-center">
                  {conceptosDisponibles.map((concepto) => (
                    <label
                      key={concepto}
                      className="flex items-center gap-2 text-sm text-gray-700"
                    >
                      <input
                        type="checkbox"
                        checked={conceptosSeleccionados.includes(concepto)}
                        onChange={() => toggleConcepto(concepto)}
                        className="form-checkbox h-4 w-4 text-rojo rounded"
                      />
                      {concepto}
                    </label>
                  ))}
                </div>

                {conceptosDisponibles.length === 0 && asig && (
                  <p className="text-sm text-gray-500 text-center mt-2">
                    No hay conceptos para esta asignatura.
                  </p>
                )}
                {!asig && (
                  <p className="text-sm text-gray-500 text-center mt-2">
                    Selecciona una asignatura para ver los conceptos.
                  </p>
                )}
              </div>

              <div className="mb-4">
                <label className="block font-medium mb-2 text-dark">
                  Nivel de dificultad ({nivel === 0 ? "Todos" : nivel})
                </label>
                <input
                  type="range"
                  min={0}
                  max={5}
                  value={nivel}
                  onChange={(e) => setNivel(parseInt(e.target.value, 10))}
                  className="w-full accent-rojo"
                />
                <div className="flex justify-between text-sm text-gray-500 mt-1">
                  <span>Todos</span>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <span key={n}>{n}</span>
                  ))}
                </div>
              </div>

              <div className="flex justify-center items-center space-x-4 mt-6">
                <button
                  onClick={aplicarFiltros}
                  className="btn-secondary text-white bg-azul rounded-lg hover:bg-rojo transition-colors py-2 px-4"
                >
                  Aplicar filtros
                </button>
                {filtrosActivos && (
                  <button
                    onClick={limpiarFiltros}
                    className="btn-secondary text-white bg-azuloscuro rounded-lg hover:bg-rojo transition-colors py-2 px-4"
                  >
                    Limpiar filtros
                  </button>
                )}
              </div>
            </DisclosurePanel>
          </>
        )}
      </Disclosure>

      {/* LISTA */}
      {loadingEjercicios ? (
        <div className="mensaje-vacio text-center p-4 text-gray-600 mt-8">
          <p>Cargando ejercicios...</p>
        </div>
      ) : errorEjercicios ? (
        <div className="mensaje-vacio text-center p-4 text-gray-600 mt-8">
          <p>{errorEjercicios}</p>
        </div>
      ) : ejerciciosFiltrados.length === 0 ? (
        <div className="mensaje-vacio text-center p-4 text-gray-600 mt-8">
          <p>
            {filtrosActivos
              ? "No se encontraron ejercicios con los filtros seleccionados."
              : "No hay ejercicios disponibles todavía."}
          </p>
        </div>
      ) : (
        <div className="ej-list max-w-4xl mx-auto mt-8">
          {/* CABECERA SOLO DESKTOP */}
          <div className="ej-head">
            <div className="ej-col ej-col-toggle" />
            <div className="ej-col ej-col-title">Título</div>
            <div className="ej-col ej-col-asig">Asignatura</div>
            <div className="ej-col ej-col-concept">Concepto</div>
            <div className="ej-col ej-col-level">Nivel</div>
            <div className="ej-col ej-col-done" />
          </div>

          <div className="ej-body">
            {ejerciciosFiltrados.map((ejercicio) => {
              const isDone = completedIds.has(String(ejercicio._id));

              return (
                <Disclosure as="div" key={ejercicio._id} className="ej-item">
                  {({ open }) => (
                    <>
                      <div className={classNames("ej-row", open ? "ej-row-open" : "")}>
                        <DisclosureButton className="ej-toggle">
                          <span className="sr-only">Ver detalles</span>
                          {open ? (
                            <ChevronUpIcon className="h-5 w-5" />
                          ) : (
                            <ChevronDownIcon className="h-5 w-5" />
                          )}
                        </DisclosureButton>

                        <div
                          className="ej-main"
                          onClick={() => handleRowClick(ejercicio._id)}
                          role="button"
                          tabIndex={0}
                        >
                          <div className="ej-title">{ejercicio.titulo}</div>

                          <div className="ej-meta">
                            <span className="ej-meta-item">{ejercicio.asignatura}</span>
                            <span className="ej-meta-sep">·</span>
                            <span className="ej-meta-item">{ejercicio.concepto}</span>
                          </div>

                          <div className="ej-asig">{ejercicio.asignatura}</div>
                          <div className="ej-concept">{ejercicio.concepto}</div>
                        </div>

                        <div className="ej-right">
                          {/* ✅ centrado del número (si tu CSS no lo hace) */}
                          <span className="ej-level-pill" style={{ display: "grid", placeItems: "center" }}>
                            {ejercicio.nivel}
                          </span>

                          {isDone ? (
                            <span className="ej-done" title="Ejercicio completado">
                              <CheckIcon className="h-5 w-5" />
                            </span>
                          ) : (
                            <span className="ej-done ej-done-empty" aria-hidden="true" />
                          )}
                        </div>
                      </div>

                      <DisclosurePanel className="ej-panel">
                        <div className="ej-panel-layout">
                          <div className="ej-panel-media">
                            {ejercicio.imagen && (
                              <img
                                src={`${import.meta.env.VITE_BASE_PATH || ""}/static/${ejercicio.imagen}`}
                                alt={ejercicio.titulo}
                                className="ej-panel-img"
                              />
                            )}
                          </div>

                          <div className="ej-panel-content">
                            <h4 className="ej-panel-title">Enunciado</h4>
                            <p className="ej-panel-text">{ejercicio.enunciado}</p>

                            <div className="ej-panel-actions">
                              <button
                                className="ej-start-btn"
                                onClick={() => handleRowClick(ejercicio._id)}
                              >
                                Comenzar ›
                              </button>
                            </div>
                          </div>
                        </div>
                      </DisclosurePanel>
                    </>
                  )}
                </Disclosure>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
