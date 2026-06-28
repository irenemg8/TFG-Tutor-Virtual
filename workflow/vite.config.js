import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      "/ws/workflow": {
        // Backend dev local en :3030 (PORT en backend/.env). Si lo cambias allí,
        // cámbialo aquí también o setea VITE_BACKEND_WS_URL en workflow/.env.
        target: "ws://localhost:3030",
        ws: true,
      },
    },
  },
});
