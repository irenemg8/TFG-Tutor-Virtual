const { detect } = require("tinyld");
const { getLanguageInstruction } = require("../src/utils/promptBuilder");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  TEST LANGUAGE DETECTION              |
            |  Standalone test harness for language detection. Drives|
            |  getLanguageInstruction over short tokens, typos and   |
            |  full sentences, checking the detected language matches |
            |  the expectation across several phases plus edge cases.|
        ____|________________                                       |
   Txt -> | assert() | -> void                                      |
          -----------------                                         |
        ____|________________                                       |
   Txt -> | expectLang() | -> void                                  |
          ----------------------                                    |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

let passed = 0;
let failed = 0;

/*
   IN -> ____|________
        | assert() | -> void
         ----------
      Records a pass or fail for a labelled boolean condition (Txt, T/F).
   */
function assert(label, condition) {
  if (condition) {
    console.log("  PASS: " + label);
    passed++;
  } else {
    console.log("  FAIL: " + label);
    failed++;
  }
}

/*
   IN -> ____|____________
        | expectLang() | -> void
         ----------------
      Asserts getLanguageInstruction(text) reports the expected language (Txt, Txt).
   */
function expectLang(text, expectedLang) {
  const instr = getLanguageInstruction(text);
  const match = instr.match(/writing in (\w+)/);
  const detected = match ? match[1] : "(none)";
  assert(JSON.stringify(text) + " -> " + detected, detected === expectedLang);
}

console.log("\n=== Phase 1: Short text detection (curated map) ===\n");

expectLang("Hello", "English");
expectLang("Hi", "English");
expectLang("Hey", "English");
expectLang("Yes", "English");
expectLang("Of course", "English");
expectLang("Ok", "English");
expectLang("Okay", "English");
expectLang("Sure", "English");
expectLang("I think", "English");
expectLang("I don't know", "English");

expectLang("Bonjour", "French");
expectLang("Salut", "French");
expectLang("Oui", "French");
expectLang("Merci", "French");
expectLang("D'accord", "French");

expectLang("Hola", "Spanish");
expectLang("Sí", "Spanish");
expectLang("Gracias", "Spanish");
expectLang("Vale", "Spanish");
expectLang("Bueno", "Spanish");

expectLang("Hallo", "German");
expectLang("Guten Tag", "German");
expectLang("Ja", "German");
expectLang("Danke", "German");

expectLang("Ciao", "Italian");
expectLang("Grazie", "Italian");
expectLang("Buongiorno", "Italian");

expectLang("Olá", "Portuguese");
expectLang("Obrigado", "Portuguese");
expectLang("Bom dia", "Portuguese");

expectLang("Bon dia", "Catalan");
expectLang("Gràcies", "Catalan");

console.log("\n=== Phase 2: Typo resilience (normalized map) ===\n");

expectLang("i dont know", "English");
expectLang("dont know", "English");
expectLang("no idea", "English");
expectLang("ola", "Portuguese");
expectLang("daccord", "French");
expectLang("tres bien", "French");
expectLang("naturlich", "German");
expectLang("perche", "Italian");
expectLang("como", "Spanish");
expectLang("gracies", "Catalan");

console.log("\n=== Phase 2: Longer text detection (tinyld) ===\n");

expectLang("I want to start the exercise. Can you guide me step by step?", "English");
expectLang("Je voudrais commencer l'exercice. Pouvez-vous m'expliquer?", "French");
expectLang("Quiero empezar el ejercicio. Guíame paso a paso.", "Spanish");
expectLang("Ich möchte die Übung beginnen. Können Sie mir helfen?", "German");
expectLang("Voglio iniziare l'esercizio. Puoi guidarmi passo dopo passo?", "Italian");
expectLang("Quero começar o exercício. Pode me guiar passo a passo?", "Portuguese");

console.log("\n=== Phase 4: Edge cases ===\n");

assert("Empty string -> empty", getLanguageInstruction("") === "");
assert("null -> empty", getLanguageInstruction(null) === "");
assert("Single char -> empty", getLanguageInstruction("a") === "");
assert("Format contains [LANGUAGE INSTRUCTION]", getLanguageInstruction("Bonjour").includes("[LANGUAGE INSTRUCTION]"));
assert("Format contains MUST respond ONLY", getLanguageInstruction("Bonjour").includes("MUST respond ONLY"));

console.log("\n=== Results ===");
console.log("Passed: " + passed + "/" + (passed + failed));
console.log("Failed: " + failed);

if (failed > 0) {
  process.exit(1);
}
