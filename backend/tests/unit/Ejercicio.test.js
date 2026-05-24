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
