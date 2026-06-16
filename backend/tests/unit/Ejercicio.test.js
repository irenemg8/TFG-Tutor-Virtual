"use strict";

const Ejercicio = require("../../src/domain/entities/Ejercicio");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  EJERCICIO — UNIT TESTS               |
            |  Verifies the derived getters of the Ejercicio entity. |
            |  Regresses the 2026-04-27 bug where number-less titles |
            |  made getExerciseNumber() return null, and BUG-EVAL-   |
            |  EMPTY (2026-06-15) where an empty evaluableElements    |
            |  must fall back to the netlist.                        |
        ____|________________                                       |
        | build() | -> Ejercicio                                    |
        -----------                                                 |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

describe("Ejercicio.getExerciseNumber", () => {
  /*
       IN -> ____|________
            | build() | -> Ejercicio
             -----------
        Builds an Ejercicio from a partial props object with sane defaults.
  */
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
