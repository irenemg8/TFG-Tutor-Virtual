"use strict";

const Ejercicio = require("../../src/domain/entities/Ejercicio");

// Regression for the 2026-04-27 bug where titles seedados como
// "Resistencias y Circuito Abierto" (sin número) hacían que
// getExerciseNumber() devolviese null y ragPipeline enrutase retrieval a
// "exercise_null" → 0 resultados. El fix añade fallback al campo `imagen`.

describe("Ejercicio.getExerciseNumber", () => {
  function build(props) {
    return new Ejercicio({
      title: props.title || "",
      statement: "",
      subject: "Dispositivos electrónicos",
      concept: "Ley de Ohm",
      level: 1,
      image: props.image || "",
    });
  }

  test('título "Ejercicio 3" → 3', () => {
    expect(build({ title: "Ejercicio 3" }).getExerciseNumber()).toBe(3);
  });

  test("título sin número, imagen Ejercicio1.jpg → 1 (fallback)", () => {
    expect(
      build({ title: "Resistencias y Circuito Abierto", image: "Ejercicio1.jpg" })
        .getExerciseNumber()
    ).toBe(1);
  });

  test("imagen con prefijo /static/ también se reconoce", () => {
    expect(
      build({ title: "Foo", image: "/static/Ejercicio7.jpg" }).getExerciseNumber()
    ).toBe(7);
  });

  test("sin título ni imagen reconocibles → null", () => {
    expect(build({ title: "Algo", image: "foo.png" }).getExerciseNumber()).toBeNull();
  });
});

// BUG-EVAL-EMPTY (2026-06-15): rows seeded before the netlist-fallback have an
// empty elementos_evaluables, which silently broke flow-negation + cumulative
// closure and sent the tutor into an infinite re-ask loop. getEvaluableElements
// must derive the set from the netlist when the explicit field is empty.
describe("Ejercicio.getEvaluableElements — netlist fallback", () => {
  const netlist = "R1 N1 N2 1\nV1 N1 0 1\nR2 N2 0 1\nR3 N3 0 1\nR4 N2 0 1\nR5 0 0 1";

  test("uses explicit evaluableElements when present", () => {
    const ej = new Ejercicio({ title: "Ejercicio 1", tutorContext: { evaluableElements: ["R1", "R2"], netlist } });
    expect(ej.getEvaluableElements()).toEqual(["R1", "R2"]);
  });

  test("derives from netlist when evaluableElements is empty", () => {
    const ej = new Ejercicio({ title: "Ejercicio 1", tutorContext: { evaluableElements: [], netlist, correctAnswer: ["R1", "R2", "R4"] } });
    expect(ej.getEvaluableElements().sort()).toEqual(["R1", "R2", "R3", "R4", "R5"]);
  });

  test("unions the correct answer even if not in the netlist", () => {
    const ej = new Ejercicio({ title: "Ejercicio 1", tutorContext: { netlist: "R1 N1 N2 1", correctAnswer: ["R1", "R9"] } });
    expect(ej.getEvaluableElements().sort()).toEqual(["R1", "R9"]);
  });

  test("returns [] when there is nothing to derive from", () => {
    const ej = new Ejercicio({ title: "Ejercicio 1", tutorContext: { netlist: "", correctAnswer: [] } });
    expect(ej.getEvaluableElements()).toEqual([]);
  });
});
