"use strict";

const AcDetectorAgent = require("../../src/domain/agents/acDetectorAgent");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |       ACDETECTORAGENT.VERDICT — UNIT TESTS (NS-30)    |
            |  Verifies AcDetectorAgent.execute() builds turnVerdict |
            |  correctly: correct / partial_correct / incorrect /   |
            |  only_negation verdicts, wronglyNegated detection,    |
            |  token normalisation and the null-verdict empty case. |
        ____|______________                                         |
        | makeContext() | -> Obj                                    |
        -----------------                                           |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
     IN -> ____|____________
          | makeContext() | -> Obj
           -----------------
    Builds an AgentContext with classification, correctAnswer and exerciseNum.
*/
function makeContext(proposed, negated, correctAnswer, exerciseNum) {
  return {
    classification: { proposed, negated },
    correctAnswer,
    exerciseNum,
    ejercicio: { tutorContext: { respuestaCorrecta: correctAnswer } },
  };
}

describe("AcDetectorAgent.turnVerdict (NS-30)", () => {
  const agent = new AcDetectorAgent();
  const correct = ["R1", "R2", "R4"];

  test("verdict=correct when proposed exactly matches correctAnswer", async () => {
    const ctx = makeContext(["R1", "R2", "R4"], [], correct, 1);
    await agent.execute(ctx);
    expect(ctx.turnVerdict.verdict).toBe("correct");
    expect(ctx.turnVerdict.hits).toEqual(["R1", "R2", "R4"]);
    expect(ctx.turnVerdict.errors).toEqual([]);
    expect(ctx.turnVerdict.missing).toEqual([]);
  });

  test("verdict=partial_correct when there is a hit + an error", async () => {
    const ctx = makeContext(["R1", "R5"], [], correct, 1);
    await agent.execute(ctx);
    expect(ctx.turnVerdict.verdict).toBe("partial_correct");
    expect(ctx.turnVerdict.hits).toEqual(["R1"]);
    expect(ctx.turnVerdict.errors).toEqual(["R5"]);
    expect(ctx.turnVerdict.missing.sort()).toEqual(["R2", "R4"]);
  });

  test("verdict=partial_correct when student gives a hit but misses some correct elements", async () => {
    const ctx = makeContext(["R1", "R2"], [], correct, 1);
    await agent.execute(ctx);
    expect(ctx.turnVerdict.verdict).toBe("partial_correct");
    expect(ctx.turnVerdict.hits.sort()).toEqual(["R1", "R2"]);
    expect(ctx.turnVerdict.errors).toEqual([]);
    expect(ctx.turnVerdict.missing).toEqual(["R4"]);
  });

  test("verdict=incorrect when no proposed element matches correctAnswer", async () => {
    const ctx = makeContext(["R5", "R3"], [], correct, 1);
    await agent.execute(ctx);
    expect(ctx.turnVerdict.verdict).toBe("incorrect");
    expect(ctx.turnVerdict.hits).toEqual([]);
    expect(ctx.turnVerdict.errors.sort()).toEqual(["R3", "R5"]);
  });

  test("verdict=only_negation when student only rejects elements", async () => {
    const ctx = makeContext([], ["R5"], correct, 1);
    await agent.execute(ctx);
    expect(ctx.turnVerdict.verdict).toBe("only_negation");
  });

  test("wronglyNegated detects student rejecting a correct element", async () => {
    const ctx = makeContext(["R1"], ["R2"], correct, 1);
    await agent.execute(ctx);
    expect(ctx.turnVerdict.wronglyNegated).toEqual(["R2"]);
    expect(ctx.turnVerdict.missing).toEqual(["R4"]);
  });

  test("normalises lowercase / whitespace tokens", async () => {
    const ctx = makeContext(["r1 ", "  R5"], [], correct, 1);
    await agent.execute(ctx);
    expect(ctx.turnVerdict.hits).toEqual(["R1"]);
    expect(ctx.turnVerdict.errors).toEqual(["R5"]);
  });

  test("turnVerdict is null when nothing is proposed and nothing is negated", async () => {
    const ctx = makeContext([], [], correct, 1);
    await agent.execute(ctx);
    expect(ctx.turnVerdict).toBeNull();
    expect(ctx.detectedACs).toEqual([]);
  });
});
