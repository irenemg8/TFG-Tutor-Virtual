// src/services/auth.js
import { api } from "./api";

/** Devuelve el usuario autenticado actual */
export async function getCurrentUser() {
  try {
    const res = await api.get("/api/auth/me");
    return res.data;
  } catch (error) {
    return { authenticated: false };
  }
}

/** Logout */
export async function logout() {
  await api.get("/api/auth/logout");
}
