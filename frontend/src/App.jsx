import Navbar from "./components/Navbar.jsx";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";

import Busqueda from "./pages/Busqueda";
import Dashboard from "./pages/Dashboard";
import Interacciones from "./pages/Interacciones";
import Home from "./pages/Home.jsx";
import Ejercicios from "./pages/Ejercicios.jsx";
import Login from "./pages/Login.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import { AuthProvider } from "./context/AuthContext.jsx";
import AdminPanel from "./pages/admin/AdminPanel.jsx";
import AdminEjercicios from "./pages/admin/AdminEjercicios.jsx";
import AdminConceptos from "./pages/admin/AdminConceptos.jsx";
import AdminConcepciones from "./pages/admin/AdminConcepciones.jsx";

export default function App() {
  const location = useLocation();
  const isLoginPage = location.pathname === "/login";

  return (
    <AuthProvider>
    <div className="flex flex-col min-h-screen w-screen bg-white">
      {!isLoginPage && <Navbar />}

      <div className="flex-1">
        <Routes>
          {/* ✅ Entrada: intenta ir a Home (si no hay sesión, ProtectedRoute te manda a Login) */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Home />
              </ProtectedRoute>
            }
          />

          {/* Pública */}
          <Route path="/login" element={<Login />} />

          {/* Privadas */}
          <Route
            path="/home"
            element={
              <ProtectedRoute>
                <Home />
              </ProtectedRoute>
            }
          />
          <Route
            path="/busqueda"
            element={
              <ProtectedRoute>
                <Busqueda />
              </ProtectedRoute>
            }
          />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/interacciones"
            element={
              <ProtectedRoute>
                <Interacciones />
              </ProtectedRoute>
            }
          />
          <Route
            path="/ejercicios"
            element={
              <ProtectedRoute>
                <Ejercicios />
              </ProtectedRoute>
            }
          />

          {/* Admin — solo profesores */}
          <Route
            path="/admin"
            element={
              <ProtectedRoute role="profesor">
                <AdminPanel />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/ejercicios"
            element={
              <ProtectedRoute role="profesor">
                <AdminEjercicios />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/conceptos"
            element={
              <ProtectedRoute role="profesor">
                <AdminConceptos />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/concepciones"
            element={
              <ProtectedRoute role="profesor">
                <AdminConcepciones />
              </ProtectedRoute>
            }
          />

          {/* ✅ Catch-all: mejor mandar a "/" (que decidirá login vs home) */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
    </AuthProvider>
  );
}
