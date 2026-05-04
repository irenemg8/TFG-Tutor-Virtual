"use strict";

const { _test } = require("../../src/interfaces/http/routes/exportRoutes");
const { flattenInteraccion, rowsToCsv, buildFilter } = _test;

describe("exportRoutes.flattenInteraccion — surfaces all per-turn signals", () => {
  const inter = {
    id: "i-1",
    usuarioId: "u-1",
    ejercicioId: "e-1",
    inicio: new Date("2026-05-04T07:00:00Z"),
    fin: new Date("2026-05-04T07:05:00Z"),
  };
  const usuario = { upvLogin: "estudiante01", nombre: "Ana", apellidos: "Pérez" };
  const ejercicio = { titulo: "Divisor de tensión simple" };

  test("user message has no metadata; assistant row has the full event payload", () => {
    const messages = [
      { role: "user", content: "¿Cómo calculo R1?", timestamp: new Date(), metadata: null },
      {
        role: "assistant",
        content: "Pista: piensa en KVL.",
        timestamp: new Date(),
        metadata: {
          classification: "wrong_answer",
          decision: "rag_examples",
          isCorrectAnswer: false,
          sourcesCount: 3,
          studentResponseMs: 4200,
          concepts: ["divisor de tensión"],
          guardrails: {
            solutionLeak: false,
            falseConfirmation: false,
            prematureConfirmation: false,
            stateReveal: false,
            languageDrift: true,
            completeSolution: false,
            adherence: true,
            repeatedQuestion: false,
            didacticExplanation: false,
            datasetStyle: false,
          },
          timing: { pipelineMs: 120, ollamaMs: 1800, totalMs: 1950, firstTokenMs: 240 },
          detectedACs: [
            { id: "AC-V1", name: "Confunde V con I", confidence: 0.82 },
            { id: "AC-R3", confidence: 0.61 },
          ],
          guardrailPath: "surgical_ok",
          guardrailLlmRetries: 0,
          guardrailSurgicalFixes: ["adherence"],
          fallbackUsed: false,
          deterministicFinish: false,
        },
      },
    ];

    const rows = flattenInteraccion(inter, messages, usuario, ejercicio);
    expect(rows).toHaveLength(2);

    const a = rows[1];
    expect(a.role).toBe("assistant");
    // Identity
    expect(a.upvLogin).toBe("estudiante01");
    expect(a.nombreCompleto).toBe("Ana Pérez");
    expect(a.ejercicioTitulo).toBe("Divisor de tensión simple");
    // Core
    expect(a.classification).toBe("wrong_answer");
    expect(a.decision).toBe("rag_examples");
    expect(a.isCorrectAnswer).toBe(false);
    expect(a.sourcesCount).toBe(3);
    expect(a.studentResponseMs).toBe(4200);
    // Timing
    expect(a.pipelineMs).toBe(120);
    expect(a.ollamaMs).toBe(1800);
    expect(a.totalMs).toBe(1950);
    expect(a.firstTokenMs).toBe(240);
    // AC verdict
    expect(a.detectedACsCount).toBe(2);
    expect(a.detectedACs).toContain("AC-V1");
    expect(a.detectedACs).toContain("AC-R3");
    // Concepts
    expect(a.concepts).toBe("divisor de tensión");
    // New guardrails
    expect(a.guardrail_languageDrift).toBe(true);
    expect(a.guardrail_adherence).toBe(true);
    expect(a.guardrail_completeSolution).toBe(false);
    expect(a.guardrail_repeatedQuestion).toBe(false);
    // Diagnostics
    expect(a.guardrailPath).toBe("surgical_ok");
    expect(a.guardrailSurgicalFixes).toBe("adherence");
    expect(a.fallbackUsed).toBe(false);
    expect(a.deterministicFinish).toBe(false);
  });

  test("rowsToCsv produces a header line and quotes content with commas", () => {
    const rows = [{ a: 1, b: "hello, world", c: true }];
    const csv = rowsToCsv(rows);
    const [header, line] = csv.split("\n");
    expect(header).toBe("a,b,c");
    expect(line).toBe('1,"hello, world",true');
  });

  test("buildFilter parses userId/exerciseId only when valid hex/uuid", () => {
    const f = buildFilter({
      userId: "507f1f77bcf86cd799439011",          // valid mongo ObjectId
      exerciseId: "not-a-real-id",                  // rejected
      from: "2026-05-01T00:00:00Z",
      to: "2026-05-04T00:00:00Z",
    });
    expect(f.userId).toBe("507f1f77bcf86cd799439011");
    expect(f.ejercicioId).toBeUndefined();
    expect(f.from instanceof Date).toBe(true);
    expect(f.to instanceof Date).toBe(true);
  });
});
