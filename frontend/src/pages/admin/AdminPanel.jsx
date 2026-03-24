// frontend/src/pages/admin/AdminPanel.jsx
import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  AcademicCapIcon,
  LightBulbIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { adminApi } from "../../services/api";

const sections = [
  {
    name: "Ejercicios",
    to: "/admin/ejercicios",
    icon: AcademicCapIcon,
    color: "text-azul",
    bg: "bg-blue-50",
    border: "border-blue-200",
    fetchCount: () => adminApi.getEjercicios().then((r) => r.data.ejercicios?.length ?? 0),
  },
  {
    name: "Conceptos",
    to: "/admin/conceptos",
    icon: LightBulbIcon,
    color: "text-green-600",
    bg: "bg-green-50",
    border: "border-green-200",
    fetchCount: () => adminApi.getConceptos().then((r) => r.data.conceptos?.length ?? 0),
  },
  {
    name: "Concepciones Alternativas",
    to: "/admin/concepciones",
    icon: ExclamationTriangleIcon,
    color: "text-rojo",
    bg: "bg-red-50",
    border: "border-red-200",
    fetchCount: () => adminApi.getConcepciones().then((r) => r.data.concepciones?.length ?? 0),
  },
];

export default function AdminPanel() {
  const [counts, setCounts] = useState({});
  const [loadingCounts, setLoadingCounts] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchAll() {
      setLoadingCounts(true);
      const results = await Promise.allSettled(sections.map((s) => s.fetchCount()));
      if (cancelled) return;
      const next = {};
      sections.forEach((s, i) => {
        if (results[i].status === "fulfilled") next[s.name] = results[i].value;
      });
      setCounts(next);
      setLoadingCounts(false);
    }

    fetchAll();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <h1 className="text-3xl font-bold text-azuloscuro mb-2">Panel de Administración</h1>
      <p className="text-gray-500 mb-8">Gestiona el contenido del Tutor Virtual.</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {sections.map((section) => {
          const Icon = section.icon;
          const count = counts[section.name];
          return (
            <Link
              key={section.name}
              to={section.to}
              className={`group flex flex-col items-center p-8 rounded-2xl border ${section.border} ${section.bg} shadow-sm hover:shadow-md transition-shadow`}
            >
              <Icon className={`h-12 w-12 mb-4 ${section.color}`} />
              <h2 className={`text-xl font-semibold ${section.color} mb-1`}>{section.name}</h2>
              {!loadingCounts && count !== undefined && (
                <span className="mt-2 inline-flex items-center justify-center px-3 py-0.5 rounded-full text-sm font-medium bg-white border border-gray-200 text-gray-700">
                  {count} {count === 1 ? "registro" : "registros"}
                </span>
              )}
              {loadingCounts && (
                <span className="mt-2 text-sm text-gray-400">Cargando...</span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
