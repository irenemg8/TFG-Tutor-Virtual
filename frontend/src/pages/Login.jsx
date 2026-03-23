import React, { useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRightOnRectangleIcon } from "@heroicons/react/24/outline";
import { demoLogin } from "../services/auth";

import logoTutor from "../assets/logotutor.png"; // ✅

export default function Login() {
  const location = useLocation();
  const [loading, setLoading] = useState(false);

  const from = location.state?.from?.pathname || "/home";
  const navigate = useNavigate();
  const isDevMode = import.meta.env.VITE_DEV_BYPASS_AUTH === "true";

  const handleSSOLogin = useCallback(() => {
    setLoading(true);
    localStorage.removeItem("tv_demo_enabled");

    const returnTo = encodeURIComponent(window.location.origin + from);
    window.location.href =
      "https://tutor-virtual.dsic.upv.es/api/auth/cas/login?returnTo=" + returnTo;
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

          <div className="tv-login__foot">
            Acceso exclusivo mediante CAS. Si tienes sesión iniciada en el
            navegador, el acceso puede ser inmediato.
          </div>

          {isDevMode && (
            <button
              type="button"
              onClick={async () => {
                await demoLogin();
                navigate(from, { replace: true });
              }}
              className="tv-login__btn"
              style={{ marginTop: "0.75rem", opacity: 0.7 }}
            >
              <span className="tv-login__btnText">⚙ Acceso dev (sin CAS)</span>
            </button>
          )}
        </main>
      </div>
    </div>
  );
}
