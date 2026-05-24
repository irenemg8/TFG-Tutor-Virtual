// src/services/api.js
import axios from "axios";

// Importante: baseURL vacío => mismo origen (158.42.187.55)
// withCredentials => manda cookies de sesión (demo/CAS)
export const api = axios.create({
  baseURL: import.meta.env.VITE_BASE_PATH || "",
  withCredentials: true,
});

// (Opcional) Interceptor para depurar errores en consola
api.interceptors.response.use(
  (res) => res,
  (err) => {
    // Log breve para debug
    console.error("[API ERROR]", err?.response?.status, err?.response?.data || err?.message);
    return Promise.reject(err);
  }
);

