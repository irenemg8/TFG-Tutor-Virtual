import React, { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";

export default function ProtectedRoute({ children }) {
  const [status, setStatus] = useState("loading"); // loading | ok | no
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;

    async function checkSession() {
      try {
        setStatus("loading");

        const basePath = import.meta.env.VITE_BASE_PATH || "";
        const resp = await fetch(basePath + "/api/auth/me", {
          method: "GET",
          credentials: "include",
          headers: { "Cache-Control": "no-cache" },
        });

        if (cancelled) return;

        if (!resp.ok) {
          setStatus("no");
          return;
        }

        const data = await resp.json().catch(() => null);
        setStatus(data?.authenticated ? "ok" : "no");
      } catch {
        if (!cancelled) setStatus("no");
      }
    }

    checkSession();

    return () => {
      cancelled = true;
    };
    // ✅ re-check en cada navegación real
  }, [location.key]);

  if (status === "loading") return <p className="p-6">Verificando sesión…</p>;

  if (status === "no") return <Navigate to="/login" replace state={{ from: location }} />;

  return children;
}
