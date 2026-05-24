import React, { useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRightOnRectangleIcon } from "@heroicons/react/24/outline";
import { demoLogin } from "../services/auth";

import logoTutor from "../assets/logotutor.png"; // ✅

export default function Login() {
  const location = useLocation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoError, setDemoError] = useState("");

  const from = location.state?.from?.pathname || "/home";

  const handleDemoLogin = useCallback(async () => {
    setDemoLoading(true);
    setDemoError("");
    try {
      await demoLogin();
      localStorage.setItem("tv_demo_enabled", "1");
      navigate(from, { replace: true });
    } catch (err) {
      setDemoError("Error al iniciar sesión demo: " + (err.message || "desconocido"));
    } finally {
      setDemoLoading(false);
    }
  }, [from, navigate]);

  const handleSSOLogin = useCallback(() => {
    setLoading(true);
    localStorage.removeItem("tv_demo_enabled");

    const basePath = import.meta.env.VITE_BASE_PATH || "";
    const returnTo = encodeURIComponent(window.location.origin + basePath + from);
    window.location.href = basePath + "/api/auth/cas/login?returnTo=" + returnTo;
  }, [from]);

  return (
    <div className="tv-login">
      <div className="tv-login__card">
        <header className="tv-login__header">
          <div className="tv-login__brand">
            <img
              src={logoTutor}
              alt="Tutor Virtual"
              className="tv-login__logo"
              loading="eager"
            />

            <div className="tv-login__titles">
              <h1 className="tv-login__title">Tutor Virtual</h1>
              <p className="tv-login__subtitle">
                Acceso mediante autenticación institucional (CAS)
              </p>
            </div>
          </div>

        
        </header>

        <main className="tv-login__body">
          <div className="tv-login__panel">
            <div className="tv-login__panelTitle">Identificación UPV</div>
            <div className="tv-login__panelText">
              Serás redirigida al sistema oficial de autenticación para iniciar
              sesión de forma segura.
            </div>
          </div>

          <button
            type="button"
            onClick={handleSSOLogin}
            disabled={loading}
            className="tv-login__btn"
          >
            <ArrowRightOnRectangleIcon className="tv-login__btnIcon" />
            <span className="tv-login__btnText">
              {loading ? "Redirigiendo…" : "Acceder con cuenta UPV"}
            </span>
          </button>

          {import.meta.env.DEV && (
            <div style={{ borderTop: "1px solid #e5e7eb", marginTop: "1rem", paddingTop: "1rem", textAlign: "center" }}>
              <p style={{ fontSize: "0.85rem", color: "#6b7280", marginBottom: "0.5rem" }}>
                Modo desarrollo local
              </p>
              <button
                type="button"
                onClick={handleDemoLogin}
                disabled={demoLoading}
                style={{
                  padding: "0.5rem 1.5rem",
                  background: "#6b7280",
                  color: "white",
                  border: "none",
                  borderRadius: "0.375rem",
                  cursor: demoLoading ? "wait" : "pointer",
                  fontSize: "0.9rem",
                }}
              >
                {demoLoading ? "Entrando…" : "Entrar como usuario demo"}
              </button>
              {demoError && (
                <p style={{ color: "#ef4444", fontSize: "0.8rem", marginTop: "0.5rem" }}>{demoError}</p>
              )}
            </div>
          )}

          <div className="tv-login__foot">
            Acceso exclusivo mediante CAS. Si tienes sesión iniciada en el
            navegador, el acceso puede ser inmediato.
          </div>
        </main>
      </div>
    </div>
  );
}
