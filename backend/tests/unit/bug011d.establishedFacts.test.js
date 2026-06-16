"use strict";

const ContextAgent = require("../../src/domain/agents/contextAgent");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |   ESTABLISHED FACTS — UNIT TESTS (BUG-011-D)          |
            |  Regresses BUG-011-D (2026-05-03): the tutor confirmed |
            |  a fact and re-asked it next turn. Verifies            |
            |  contextAgent._extractEstablishedFacts pulls prior     |
            |  affirmations (not questions), dedupes them, caps at   |
            |  5, and tolerates null/empty content.                 |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

describe("contextAgent._extractEstablishedFacts (BUG-011-D)", () => {
  const a = Object.create(ContextAgent.prototype);

  test("extrae afirmación 'Sí, R1 conecta N1 con N2'", () => {
    const msgs = [
      { content: "Sí, R1 conecta N1 con N2. ¿Otra cosa?" },
    ];
    const facts = a._extractEstablishedFacts(msgs);
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts.some((f) => /R1/.test(f) && /conecta/.test(f))).toBe(true);
  });

  test("extrae afirmación 'R2 está en paralelo con R4'", () => {
    const msgs = [
      { content: "Bien. R2 está en paralelo con R4. ¿Y ahora?" },
    ];
    const facts = a._extractEstablishedFacts(msgs);
    expect(facts.some((f) => /R2/.test(f) && /está/.test(f))).toBe(true);
  });

  test("deduplica hechos repetidos en distintos turnos", () => {
    const msgs = [
      { content: "Sí, R1 conecta N1 con N2." },
      { content: "Recuerda: R1 conecta N1 con N2." },
    ];
    const facts = a._extractEstablishedFacts(msgs);
    expect(facts.filter((f) => /R1.*conecta.*N1/.test(f)).length).toBe(1);
  });

  test("limita a 5 hechos únicos", () => {
    const msgs = [
      { content: "R1 está en serie. R2 está en paralelo. R3 conecta N1. R4 forma parte de la malla. R5 es el cortocircuito. R6 está abierto." },
    ];
    const facts = a._extractEstablishedFacts(msgs);
    expect(facts.length).toBeLessThanOrEqual(5);
  });

  test("array vacío devuelve array vacío", () => {
    expect(a._extractEstablishedFacts([])).toEqual([]);
  });

  test("mensajes sin afirmaciones devuelven array vacío", () => {
    const msgs = [
      { content: "¿Qué crees? ¿Cuál es la siguiente?" },
      { content: "Vamos a pensar juntos." },
    ];
    const facts = a._extractEstablishedFacts(msgs);
    expect(facts).toEqual([]);
  });

  test("no rompe con content nulo o undefined", () => {
    const msgs = [
      { content: null },
      { content: undefined },
      {},
    ];
    expect(a._extractEstablishedFacts(msgs)).toEqual([]);
  });

  test("escenario de la traza real: conecta N1 con N2 + hint sobre N0", () => {
    const msgs = [
      { content: "N1 y N2." },
      { content: "Sí, R1 conecta N1 con N2. ¿Podrías decirme a qué nodo está conectada la otra terminal de R1?" },
    ];
    const facts = a._extractEstablishedFacts(msgs);
    const r1Connects = facts.filter((f) => /R1[^.!?\n]*conecta/i.test(f));
    expect(r1Connects.length).toBeGreaterThanOrEqual(1);
  });
});
