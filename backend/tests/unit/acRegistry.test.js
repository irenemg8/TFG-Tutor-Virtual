"use strict";

const { matchACs } = require("../../src/domain/services/acRegistry");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |             ACREGISTRY — UNIT TESTS                   |
            |  Verifies matchACs() pattern matching (includes /     |
            |  excludes / missesAny / missesAll / proposedSetEquals |
            |  + confidence ordering + normalisation), the          |
            |  acDetectorAgent integration with AgentContext, the   |
            |  queryClassifier mixed-proposal path, and BUG-AC-      |
            |  NUMERIC (2026-06-14): element ACs must not fire when  |
            |  the correct answer is numeric/text.                  |
        ____|________________                                       |
        | buildContext() | -> Obj                                   |
        ------------------                                          |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

const ej1Patterns = [
  {
    id: "AC1",
    name: "Modelo del circuito abierto",
    misconception: "Incluye R3",
    strategy: "Pregunta sobre la rama interrumpida",
    match: { includes: ["R3"] },
  },
  {
    id: "AC6",
    name: "Modelo del cortocircuito",
    misconception: "Incluye R5",
    strategy: "Pregunta qué tienen en común sus terminales",
    match: { includes: ["R5"] },
  },
  {
    id: "AC9",
    name: "Razonamiento local",
    misconception: "Olvida R4",
    strategy: "Recuerda mirar el camino global",
    match: { missesAny: ["R4", "R1", "R2"] },
  },
];
const ej1Correct = ["R1", "R2", "R4"];

describe("acRegistry.matchACs", () => {
  test("R4+R5 → AC6 first (R5 wrongly included), AC9 second (missing R1,R2)", () => {
    const ms = matchACs(ej1Patterns, ["R4", "R5"], [], ej1Correct);
    expect(ms.length).toBeGreaterThanOrEqual(2);
    expect(ms[0].id).toBe("AC6");
    expect(ms[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(ms.find((m) => m.id === "AC9")).toBeTruthy();
  });

  test("R1+R2+R3+R4 → AC1 (wrongly includes R3)", () => {
    const ms = matchACs(ej1Patterns, ["R1", "R2", "R3", "R4"], [], ej1Correct);
    expect(ms[0].id).toBe("AC1");
    expect(ms[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("R1+R2 → only AC9 (missing R4)", () => {
    const ms = matchACs(ej1Patterns, ["R1", "R2"], [], ej1Correct);
    expect(ms.length).toBe(1);
    expect(ms[0].id).toBe("AC9");
  });

  test("R1+R2+R4 (correct answer) → no AC", () => {
    const ms = matchACs(ej1Patterns, ["R1", "R2", "R4"], [], ej1Correct);
    expect(ms).toEqual([]);
  });

  test("excludes pattern fires when student rejects a correct element", () => {
    const patterns = [{ id: "AC13", match: { excludes: ["R1"] }, misconception: "x", strategy: "y" }];
    const ms = matchACs(patterns, [], ["R1"], ["R1", "R2"]);
    expect(ms[0].id).toBe("AC13");
  });

  test("excludes does NOT fire when student correctly rejects an absent element", () => {
    const patterns = [{ id: "AC1", match: { excludes: ["R3"] }, misconception: "x", strategy: "y" }];
    const ms = matchACs(patterns, [], ["R3"], ["R1", "R2"]);
    expect(ms).toEqual([]);
  });

  test("missesAll fires only when all listed elements are missing", () => {
    const patterns = [{ id: "AC14", match: { missesAll: ["R1", "R2"] }, misconception: "x", strategy: "y" }];
    expect(matchACs(patterns, ["R4"], [], ["R1", "R2", "R4"])[0]?.id).toBe("AC14");
    expect(matchACs(patterns, ["R1", "R4"], [], ["R1", "R2", "R4"])).toEqual([]);
  });

  test("proposedSetEquals exact match", () => {
    const patterns = [{ id: "ACx", match: { proposedSetEquals: ["R3", "R4"] }, misconception: "x", strategy: "y" }];
    expect(matchACs(patterns, ["R3", "R4"], [], ["R1"])[0]?.id).toBe("ACx");
    expect(matchACs(patterns, ["R3", "R4", "R5"], [], ["R1"])).toEqual([]);
  });

  test("returns empty when patterns are empty/null", () => {
    expect(matchACs(null, ["R1"], [], ["R1"])).toEqual([]);
    expect(matchACs([], ["R1"], [], ["R1"])).toEqual([]);
  });

  test("normalises lowercase input", () => {
    const ms = matchACs(ej1Patterns, ["r5"], [], ej1Correct);
    expect(ms[0].id).toBe("AC6");
  });
});

describe("acDetectorAgent (integration with AgentContext)", () => {
  const AcDetectorAgent = require("../../src/domain/agents/acDetectorAgent");

  /*
       IN -> ____|_____________
            | buildContext() | -> Obj
             ------------------
      Builds an AgentContext from an options bag with defaults for type,
      proposed, negated, exerciseNum and correctAnswer.
  */
  function buildContext(opts) {
    return {
      classification: {
        type: opts.type || "wrong_answer",
        proposed: opts.proposed || [],
        negated: opts.negated || [],
      },
      exerciseNum: opts.exerciseNum != null ? opts.exerciseNum : 1,
      correctAnswer: opts.correctAnswer || ej1Correct,
    };
  }

  test("populates context.detectedACs ordered by confidence (uses acRegistry by exerciseNum)", async () => {
    const agent = new AcDetectorAgent();
    const ctx = buildContext({ proposed: ["R4", "R5"], exerciseNum: 1 });
    await agent.execute(ctx);
    expect(Array.isArray(ctx.detectedACs)).toBe(true);
    expect(ctx.detectedACs[0].id).toBe("AC6");
    expect(ctx.detectedACs[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("canSkip when no proposal/rejection in classification", () => {
    const agent = new AcDetectorAgent();
    expect(agent.canSkip({ classification: { proposed: [], negated: [] } })).toBe(true);
    expect(agent.canSkip({ classification: { proposed: ["R1"], negated: [] } })).toBe(false);
  });

  test("returns empty array when exerciseNum is unknown", async () => {
    const agent = new AcDetectorAgent();
    const ctx = {
      classification: { proposed: ["R5"], negated: [] },
      exerciseNum: 999,
      correctAnswer: ["R1"],
    };
    await agent.execute(ctx);
    expect(ctx.detectedACs).toEqual([]);
  });
});

describe("queryClassifier mixed proposal → partial_correct", () => {
  const { classifyQuery, types } = require("../../src/domain/services/rag/queryClassifier");

  test("R4 y R5 (uno correcto + uno incorrecto) → partial_correct (no wrong_answer)", () => {
    const r = classifyQuery("R4 y R5", ["R1", "R2", "R4"], ["R1", "R2", "R3", "R4", "R5"]);
    expect(r.type).toBe(types.partialCorrect);
    expect(r.proposed.sort()).toEqual(["R4", "R5"]);
  });

  test("R3 y R4 (R4 correcto + R3 wrongly included) → partial_correct", () => {
    const r = classifyQuery("R3 y R4", ["R1", "R2", "R4"], ["R1", "R2", "R3", "R4", "R5"]);
    expect(r.type).toBe(types.partialCorrect);
  });

  test("Only wrong elements (R3 y R5) → wrong_answer (no mix correct+wrong)", () => {
    const r = classifyQuery("R3 y R5", ["R1", "R2", "R4"], ["R1", "R2", "R3", "R4", "R5"]);
    expect(r.type).toBe(types.wrongAnswer);
  });

  test("Only correct elements but incomplete (R1 y R2) → partial_correct as before", () => {
    const r = classifyQuery("R1 y R2", ["R1", "R2", "R4"], ["R1", "R2", "R3", "R4", "R5"]);
    expect(r.type).toBe(types.partialCorrect);
  });
});

describe("acRegistry.matchACs — numeric/text correct answer guard", () => {
  const ej6Patterns = [
    { id: "AC2", name: "Atenuación", misconception: "x", strategy: "y",
      match: { includes: ["R1", "R2", "R3", "R4", "R5", "R6"] } },
    { id: "AC14", name: "Serie/paralelo", misconception: "x", strategy: "y",
      match: { includes: ["R1", "R2", "R3", "R4", "R5", "R6"] } },
  ];
  const numericAnswer = ["por todas las resistencias pasa la misma corriente"];

  test("does NOT fire element ACs when correct answer is text", () => {
    const r = matchACs(ej6Patterns, ["R1", "R2", "R3", "R4", "R5", "R6"], [], numericAnswer);
    expect(r).toEqual([]);
  });

  test("still fires normally when correct answer IS an element set", () => {
    const r = matchACs(ej1Patterns, ["R1", "R2", "R3", "R4"], [], ej1Correct);
    expect(r.map((a) => a.id)).toContain("AC1");
  });
});
