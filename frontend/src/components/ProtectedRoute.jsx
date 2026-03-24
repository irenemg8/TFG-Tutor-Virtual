import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function ProtectedRoute({ children, role }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <p className="p-6">Verificando sesión…</p>;

  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;

  if (role && user.rol !== role) return <Navigate to="/" replace />;

  return children;
}
