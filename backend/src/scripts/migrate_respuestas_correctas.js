const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

const Ejercicio = require("../infrastructure/persistence/mongodb/models/ejercicio");

// ✅ Ajusta si tu variable se llama distinto
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

function toArrayOfStrings(correctAnswer) {
  if (Array.isArray(correctAnswer)) {
    return correctAnswer.map(String).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof correctAnswer === "string") {
    const s = correctAnswer.trim();
    return s ? [s] : [];
  }
  return [];
}

async function main() {
  if (!MONGO_URI) {
    console.error("❌ Falta MONGO_URI/MONGODB_URI en el entorno (.env).");
    process.exit(1);
  }

  // Lee tu JSON (el de benchmark)
  const jsonPath = path.join(__dirname, "..", "data", "ohm_exercises.json");
  if (!fs.existsSync(jsonPath)) {
    console.error("❌ No existe:", jsonPath);
    process.exit(1);
  }

  const raw = fs.readFileSync(jsonPath, "utf-8");
  const parsed = JSON.parse(raw);

  const exercises = Array.isArray(parsed?.exercises) ? parsed.exercises : [];
  if (!exercises.length) {
    console.error("❌ El JSON no tiene parsed.exercises o está vacío.");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log("✅ Conectado a MongoDB");

  let ok = 0;
  let miss = 0;

  for (const e of exercises) {
    const id = e?.id; // 1..7
    const correctAnswer = e?.correct_answer;
    const respuesta = toArrayOfStrings(correctAnswer);

    if (!id) continue;

    // Busca por título: "Ejercicio 1", "Ejercicio 2", etc.
    const titulo = `Ejercicio ${id}`;

    const r = await Ejercicio.updateOne(
      { titulo, concepto: "Ley de Ohm" },
      {
        $set: {
          "tutorContext.respuestaCorrecta": respuesta,
        },
      }
    );

    if (r.matchedCount === 0) {
      console.warn(`⚠️ No encontrado en Mongo: ${titulo} (concepto Ley de Ohm)`);
      miss++;
    } else {
      console.log(`✅ ${titulo} -> respuestaCorrecta =`, respuesta);
      ok++;
    }
  }

  console.log(`\nResumen: OK=${ok}, NO_ENCONTRADOS=${miss}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
