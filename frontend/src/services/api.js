// src/services/api.js
import axios from "axios";

// Importante: baseURL vacío => mismo origen (158.42.187.55)
// withCredentials => manda cookies de sesión (demo/CAS)
export const api = axios.create({
  baseURL: "",
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

// Admin API — requiere rol profesor en sesión
export const adminApi = {
  // Ejercicios
  getEjercicios: () => api.get("/api/admin/ejercicios"),
  getEjercicio: (id) => api.get(`/api/admin/ejercicios/${id}`),
  createEjercicio: (data) => api.post("/api/admin/ejercicios", data),
  updateEjercicio: (id, data) => api.put(`/api/admin/ejercicios/${id}`, data),
  deleteEjercicio: (id) => api.delete(`/api/admin/ejercicios/${id}`),
  uploadImagen: (id, formData) =>
    api.post(`/api/admin/ejercicios/${id}/imagen`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
    }),
  // Conceptos
  getConceptos: () => api.get("/api/admin/conceptos"),
  createConcepto: (data) => api.post("/api/admin/conceptos", data),
  updateConcepto: (id, data) => api.put(`/api/admin/conceptos/${id}`, data),
  deleteConcepto: (id) => api.delete(`/api/admin/conceptos/${id}`),
  // Concepciones
  getConcepciones: () => api.get("/api/admin/concepciones"),
  createConcepcion: (data) => api.post("/api/admin/concepciones", data),
  updateConcepcion: (id, data) => api.put(`/api/admin/concepciones/${id}`, data),
  deleteConcepcion: (id) => api.delete(`/api/admin/concepciones/${id}`),
};

