"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const Ejercicio = require("../../src/domain/entities/Ejercicio");
const { buildTutorSystemPrompt } = require("../../src/domain/services/promptBuilder");

const CTX_JSON = path.join(
  __dirname,
  "..",
  "..",
  "src",
  "data",
  "contextos-ejercicios",
  "tutorContext_por_ejercicio.json"
);

function loadCtxArr() {
  return JSON.parse(fs.readFileSync(CTX_JSON, "utf8"));
}

function buildEjercicio(item) {
  return new Ejercicio({
    id: String(item.ejercicio),
    titulo: "Ejercicio " + item.ejercicio,
    enunciado: "",
    asignatura: "Dispositivos electrónicos",
    concepto: "Ley de Ohm",
    nivel: 1,
    imagen: "Ejercicio" + item.ejercicio + ".jpg",
    tutorContext: item.tutorContext,
  });
}

describe("tutorContext_por_ejercicio.json — pedagogical data quality", () => {
  const ctxArr = loadCtxArr();

  test("the JSON contains all 7 exercises", () => {
    expect(ctxArr).toHaveLength(7);
    expect(ctxArr.map((x) => x.ejercicio).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test.each(ctxArr.map((x) => [x.ejercicio, x]))(
    "Ej %i has every required pedagogical field",
    (_, item) => {
      const tc = item.tutorContext;
      expect(typeof tc.objetivo).toBe("string");
      expect(tc.objetivo.trim().length).toBeGreaterThanOrEqual(30);
      expect(typeof tc.netlist).toBe("string");
      expect(tc.netlist.trim().length).toBeGreaterThanOrEqual(10);
      expect(typeof tc.modoExperto).toBe("string");
      expect(tc.modoExperto.trim().length).toBeGreaterThanOrEqual(50);
      expect(Array.isArray(tc.respuestaCorrecta)).toBe(true);
      expect(tc.respuestaCorrecta.length).toBeGreaterThan(0);
      expect(Array.isArray(tc.ac_refs)).toBe(true);
      expect(tc.ac_refs.length).toBeGreaterThan(0);
    }
  );

  test.each(ctxArr.map((x) => [x.ejercicio, x]))(
    "Ej %i passes Ejercicio.hasValidTutorContext()",
    (_, item) => {
      const ej = buildEjercicio(item);
      expect(ej.hasValidTutorContext()).toBe(true);
    }
  );

  test.each(ctxArr.map((x) => [x.ejercicio, x]))(
    "buildTutorSystemPrompt(Ej %i) emits NO '(not defined)' placeholder",
    (_, item) => {
      const ej = buildEjercicio(item);
      const prompt = buildTutorSystemPrompt(ej, "es");
      expect(prompt).not.toMatch(/\(not defined\)/i);
      // Block headers must appear because every exercise now has data.
      expect(prompt).toContain("OBJECTIVE:");
      expect(prompt).toContain("EXPERT REASONING");
      expect(prompt).toContain("CORRECT ANSWER (ELEMENTS):");
      expect(prompt).toContain("CONTEXT VERSION:");
    }
  );

  test("no exercise is a literal clone of another (modoExperto+netlist must differ verbatim)", () => {
    const fingerprints = new Map();
    for (const item of ctxArr) {
      const tc = item.tutorContext;
      const sig = crypto
        .createHash("md5")
        .update((tc.modoExperto || "") + "||" + (tc.netlist || ""))
        .digest("hex");
      if (fingerprints.has(sig)) {
        throw new Error(
          "Ej " +
            item.ejercicio +
            " is a literal clone of Ej " +
            fingerprints.get(sig) +
            " (same modoExperto+netlist). This is the bug fixed in NS-1."
        );
      }
      fingerprints.set(sig, item.ejercicio);
    }
    expect(fingerprints.size).toBe(ctxArr.length);
  });
});

describe("Ejercicio.hasValidTutorContext — completeness checks", () => {
  function build(tutorContext) {
    return new Ejercicio({
      id: "x",
      titulo: "Ejercicio 1",
      enunciado: "",
      asignatura: "Dispositivos electrónicos",
      concepto: "Ley de Ohm",
      nivel: 1,
      imagen: "Ejercicio1.jpg",
      tutorContext,
    });
  }

  test("rejects null tutorContext", () => {
    expect(build(undefined).hasValidTutorContext()).toBe(false);
  });

  test("rejects empty respuestaCorrecta", () => {
    expect(
      build({
        objetivo: "x".repeat(40),
        netlist: "R1 N1 N2 1",
        modoExperto: "y".repeat(60),
        respuestaCorrecta: [],
      }).hasValidTutorContext()
    ).toBe(false);
  });

  test("rejects too-short objetivo", () => {
    expect(
      build({
        objetivo: "corto",
        netlist: "R1 N1 N2 1",
        modoExperto: "y".repeat(60),
        respuestaCorrecta: ["R1"],
      }).hasValidTutorContext()
    ).toBe(false);
  });

  test("rejects too-short modoExperto", () => {
    expect(
      build({
        objetivo: "x".repeat(40),
        netlist: "R1 N1 N2 1",
        modoExperto: "corto",
        respuestaCorrecta: ["R1"],
      }).hasValidTutorContext()
    ).toBe(false);
  });

  test("accepts complete tutorContext", () => {
    expect(
      build({
        objetivo: "x".repeat(40),
        netlist: "R1 N1 N2 1",
        modoExperto: "y".repeat(60),
        respuestaCorrecta: ["R1"],
      }).hasValidTutorContext()
    ).toBe(true);
  });
});

describe("buildTutorSystemPrompt — placeholder defense", () => {
  test("omits OBJECTIVE block when objetivo is missing instead of writing '(not defined)'", () => {
    const ej = new Ejercicio({
      id: "x",
      titulo: "Ejercicio",
      enunciado: "",
      asignatura: "Dispositivos electrónicos",
      concepto: "Ley de Ohm",
      nivel: 1,
      imagen: "Ejercicio1.jpg",
      tutorContext: {
        objetivo: "",
        netlist: "R1 N1 N2 1",
        modoExperto: "y".repeat(60),
        ac_refs: ["AC1"],
        respuestaCorrecta: ["R1"],
      },
    });
    const prompt = buildTutorSystemPrompt(ej, "es");
    expect(prompt).not.toMatch(/\(not defined\)/i);
    expect(prompt).not.toContain("OBJECTIVE:");
    expect(prompt).toContain("EXPERT REASONING");
  });

  test("omits CORRECT ANSWER block when respuestaCorrecta is empty", () => {
    const ej = new Ejercicio({
      id: "x",
      titulo: "Ejercicio",
      enunciado: "",
      asignatura: "Dispositivos electrónicos",
      concepto: "Ley de Ohm",
      nivel: 1,
      imagen: "Ejercicio1.jpg",
      tutorContext: {
        objetivo: "x".repeat(40),
        netlist: "R1 N1 N2 1",
        modoExperto: "y".repeat(60),
        ac_refs: ["AC1"],
        respuestaCorrecta: [],
      },
    });
    const prompt = buildTutorSystemPrompt(ej, "es");
    expect(prompt).not.toMatch(/\(not defined\)/i);
    expect(prompt).not.toContain("CORRECT ANSWER (ELEMENTS):");
  });
});
