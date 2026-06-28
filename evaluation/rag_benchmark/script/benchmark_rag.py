#!/usr/bin/env python3
"""
------------------------------------------------------------------------------
            _________________________________________________________
            |                       BENCHMARK RAG                   |
            |  Runs the Socratic Ohm's-law tutor benchmark by        |
            |  driving the real backend RAG pipeline, scoring every  |
            |  turn (efficiency, pedagogy, AC detection) and writing |
            |  the JSON and 7-sheet XLSX comparison reports.         |
        ____|________________                                        |
   Txt -> | extract_think() | -> (Txt, Txt)                          |
          -------------------                                        |
        ____|___________________________                             |
        | detect_acs_in_response() | -> [Txt]                        |
        ---------------------------                                  |
        ____|_________________________                               |
        | evaluate_socraticidad() | -> (Z, Txt)                      |
        --------------------------                                   |
        ____|________________________________                        |
        | evaluate_precision_conceptual() | -> (Z, Txt)              |
        ----------------------------------                           |
        ____|_______________________                                 |
        | evaluate_consistencia() | -> (Z, Txt)                      |
        --------------------------                                   |
        ____|__________________________                              |
        | evaluate_tasa_alucinacion() | -> (Z, Txt)                  |
        ------------------------------                               |
        ____|___________________________                             |
        | compute_cot_faithfulness() | -> R                          |
        -----------------------------                                |
        ____|________________________                               |
        | compute_cot_relevance() | -> R                             |
        --------------------------                                   |
        ____|________________                                        |
        | build_feedback() | -> Txt                                  |
        -------------------                                          |
        ____|__________________                                      |
        | build_rag_prompt() | -> Txt                                |
        ---------------------                                        |
        ____|________________                                        |
        | save_json() | -> Path                                      |
        ---------------                                              |
        ____|_________________________                               |
        | compute_model_stats() | -> dict                            |
        ------------------------                                     |
        ____|___________________                                     |
        | build_sheet_name() | -> Txt                                |
        ---------------------                                        |
        ____|_____________________                                   |
        | build_formula_range() | -> Txt                             |
        ------------------------                                     |
        ____|________________                                        |
        | save_xlsx() | -> Path                                      |
        ---------------                                              |
        ____|___________________                                     |
        | print_summary() | -> void                                  |
        ------------------                                           |
        ____|___________                                             |
        | main() | -> void                                           |
        ----------                                                   |
            |                                                        |
            |  Classes: EvalResult, RagKnowledgeBase,                |
            |           BackendClient, RagBenchmark                  |
            |________________________________________________________|
------------------------------------------------------------------------------
"""

import os
import re
import sys
import json
import time
import argparse
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict, field

import numpy as np
import pandas as pd
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:3030")

_SCRIPT_DIR = Path(__file__).parent
DATA_DIR    = (_SCRIPT_DIR / "../../../backend/src/data").resolve()
OUTPUT_DIR  = (_SCRIPT_DIR / "../results").resolve()

ALL_EXERCISES = [1, 3, 4, 5, 6, 7]

THRESHOLDS = {
    "optimal_latency":    3.0,
    "acceptable_latency": 5.0,
    "minimum_throughput": 20,
    "minimum_socratic":   0.8,
}


@dataclass
class EvalResult:
    """
            _________________________________________________________
            |                       EVALRESULT                      |
            |  Dataclass holding every metric of a single benchmark |
            |  turn: identification, test data, RAG context, model  |
            |  output, efficiency, AC detection, pedagogy and CoT.  |
        ____|________________                                        |
        | to_dict() | -> Dict          (reads all attributes)        |
        -------------                                                |
            |________________________________________________________|
    """
    model:           str
    ejercicio:       int
    sample_id:       int
    conversation_id: int
    turn:            int

    student_answer: str
    expected_tutor: str
    expected_acs:   List[str]

    retrieved_context: str
    rag_prompt:        str

    model_response: str
    think_content:  str
    tutor_response: str

    latencia:        float
    tokens_generados: int

    detected_acs:    List[str]
    true_positives:  List[str]
    false_positives: List[str]
    false_negatives: List[str]
    ac_precision:    float
    ac_recall:       float
    ac_f1:           float

    socraticidad:         int
    precision_conceptual: int
    consistencia:         int
    tasa_alucinacion:     int
    score_total:          int

    faithfulness: Optional[float]
    relevance:    Optional[float]

    feedback_constructivo: str
    timestamp: str = ""

    def to_dict(self) -> Dict:
        """
           IN -> ____|__________
                | to_dict() | -> Dict
                 -----------
           Returns the result as a plain dictionary via dataclasses.asdict.
        """
        return asdict(self)


class RagKnowledgeBase:
    """
            _________________________________________________________
            |                   RAGKNOWLEDGEBASE                    |
            |  Loads the exercise tutor contexts and the global     |
            |  alternative-conception definitions, and exposes the  |
            |  context retrieval and AC-matching rules used during  |
            |  evaluation.                                          |
        ____|________________                                        |
   Path -> | __init__() | -> void   (writes _ctx (dict), _ac_defs (dict))|
           ------------                                              |
        ____|____________                                            |
        | retrieve() | -> Txt                                        |
        -------------                                                |
        ____|___________________                                     |
        | expected_acs_for() | -> [Txt]                              |
        ---------------------                                        |
        ____|___________________                                     |
        | get_ac_patterns() | -> [Dict]                              |
        --------------------                                         |
        ____|________________                                        |
        | get_enunciado() | -> Txt                                   |
        -------------------                                          |
            |________________________________________________________|
    """

    def __init__(self, data_dir: Path):
        """
           IN -> Path ____|___________
                      | __init__() | -> void   (writes _ctx (dict), _ac_defs (dict))
                       ------------
           Loads tutorContext_por_ejercicio.json and
           alternative_conceptions.json from the given data directory.
        """
        ctx_path = data_dir / "contextos-ejercicios" / "tutorContext_por_ejercicio.json"
        with open(ctx_path, encoding="utf-8") as f:
            raw = json.load(f)

        self._ctx: Dict[int, Dict] = {}
        for entry in raw:
            exercise_id = entry["ejercicio"]
            self._ctx[exercise_id] = entry["tutorContext"]

        ac_path = data_dir / "alternative_conceptions.json"
        with open(ac_path, encoding="utf-8") as f:
            self._ac_defs: Dict[str, Dict] = json.load(f).get("alternative_conceptions", {})

        print(f"  RAG KB loaded: {len(self._ctx)} exercises, "
              f"{len(self._ac_defs)} global ACs")

    def retrieve(self, exercise_id: int) -> str:
        """
           IN -> Z ____|____________
                  | retrieve() | -> Txt   (reads _ctx (dict), _ac_defs (dict))
                   ------------
           Returns the structured context string (statement, expert mode
           and possible ACs) for the given exercise.
        """
        ctx = self._ctx.get(exercise_id)
        if not ctx:
            return f"[No context available for exercise {exercise_id}]"

        lines = [
            f"=== RETRIEVED CONTEXT: EXERCISE {exercise_id} ===",
            "",
            "STATEMENT:",
            ctx.get("enunciado", ""),
            "",
            "EXPERT THINKING MODE:",
            ctx.get("modoExperto", ""),
            "",
            "POSSIBLE ALTERNATIVE CONCEPTIONS IN THIS EXERCISE:",
        ]

        for pattern in ctx.get("acPatterns", []):
            ac_id   = pattern["id"]
            ac_name = pattern.get("name", "")
            misc    = pattern.get("misconception", "")
            strat   = pattern.get("strategy", "")
            ac_def  = self._ac_defs.get(ac_id, {})
            desc    = ac_def.get("description", "")
            lines.append(f"  - {ac_id} - {ac_name}: {desc}")
            lines.append(f"    Typical error: {misc}")
            lines.append(f"    Pedagogical strategy: {strat}")

        return "\n".join(lines)

    def expected_acs_for(self, exercise_id: int, student_answer: str) -> List[str]:
        """
           IN -> Z, Txt ____|____________________
                        | expected_acs_for() | -> [Txt]   (reads _ctx (dict))
                         ---------------------
           Applies the 'match' rules in acPatterns (includes -> mentions a
           wrong component, missesAny -> omits a correct one) to list which
           ACs the student answer exhibits.
        """
        ctx = self._ctx.get(exercise_id, {})
        answer_upper = student_answer.upper()
        found_acs = []

        for pattern in ctx.get("acPatterns", []):
            match_rules = pattern.get("match", {})
            includes_list  = match_rules.get("includes",  [])
            misses_any_list = match_rules.get("missesAny", [])

            if includes_list:
                for rule in includes_list:
                    if rule.upper() in answer_upper:
                        found_acs.append(pattern["id"])
                        break
                else:
                    if misses_any_list:
                        for rule in misses_any_list:
                            if rule.upper() not in answer_upper:
                                found_acs.append(pattern["id"])
                                break
            elif misses_any_list:
                for rule in misses_any_list:
                    if rule.upper() not in answer_upper:
                        found_acs.append(pattern["id"])
                        break

        return found_acs

    def get_ac_patterns(self, exercise_id: int) -> List[Dict]:
        """
           IN -> Z ____|___________________
                  | get_ac_patterns() | -> [Dict]   (reads _ctx (dict))
                   --------------------
           Returns the list of AC patterns for the given exercise.
        """
        return self._ctx.get(exercise_id, {}).get("acPatterns", [])

    def get_enunciado(self, exercise_id: int) -> str:
        """
           IN -> Z ____|________________
                  | get_enunciado() | -> Txt   (reads _ctx (dict))
                   -----------------
           Returns the problem statement for the given exercise.
        """
        return self._ctx.get(exercise_id, {}).get("enunciado", "")


class BackendClient:
    """
            _________________________________________________________
            |                     BACKENDCLIENT                     |
            |  HTTP client for the Node.js backend that runs the    |
            |  full RAG pipeline (ragMiddleware -> ChromaDB ->      |
            |  Orchestrator -> GuardrailPipeline -> LLM streaming). |
            |  Handles login, exercise mapping and SSE chat.        |
        ____|________________                                        |
   Txt -> | __init__() | -> void   (writes base_url (Txt), session (Obj),|
          ------------               exercise_map (dict))             |
        ____|_________                                               |
        | login() | -> void                                          |
        ----------                                                   |
        ____|__________________                                      |
        | load_exercises() | -> void                                 |
        -------------------                                          |
        ____|___________________                                     |
        | set_exercise_map() | -> void                               |
        --------------------                                         |
        ____|________________                                        |
        | stream_chat() | -> (Txt, Txt | null, R, Z)                 |
        ----------------                                             |
        ____|_________                                               |
        | check() | -> T/F                                           |
        ----------                                                   |
            |________________________________________________________|
    """

    def __init__(self, base_url: str = BACKEND_URL):
        """
           IN -> Txt ____|___________
                     | __init__() | -> void   (writes base_url (Txt), session (Obj), exercise_map (dict))
                      ------------
           Initializes the HTTP session (TLS verification off) and an empty
           benchmark-number to DB-id exercise map.
        """
        self.base_url = base_url.rstrip("/")
        self.session  = requests.Session()
        self.session.verify = False
        self.exercise_map: Dict[int, str] = {}

    def login(self) -> None:
        """
           IN -> ____|_______
                | login() | -> void   (reads base_url (Txt), session (Obj))
                 ---------
           Logs in via the DEV_BYPASS_AUTH dev-login endpoint and stores the
           session cookie; raises on failure.
        """
        url  = f"{self.base_url}/api/auth/dev-login"
        resp = self.session.post(url, json={}, timeout=10)
        if resp.status_code not in (200, 201):
            raise RuntimeError(
                f"dev-login failed ({resp.status_code}): {resp.text[:200]}\n"
                "Make sure DEV_BYPASS_AUTH=true is set in backend/.env"
            )
        print(f"  [BackendClient] Logged in OK (status={resp.status_code})")

    def load_exercises(
        self,
        exercise_numbers: List[int],
        bench_enunciados: Dict[int, str],
    ) -> None:
        """
           IN -> [Z], dict ____|__________________
                           | load_exercises() | -> void   (writes exercise_map (dict))
                            -------------------
           Fetches all backend exercises and maps each benchmark number to a
           DB id by matching the first 20 chars of the statement; raises when
           nothing maps.
        """
        resp = self.session.get(f"{self.base_url}/api/ejercicios", timeout=10)
        if resp.status_code != 200:
            raise RuntimeError(f"GET /api/ejercicios failed: {resp.status_code}")

        db_exercises = resp.json()
        print(f"  [BackendClient] {len(db_exercises)} exercises in DB")

        for ex_num in exercise_numbers:
            enunciado = bench_enunciados.get(ex_num, "")
            snippet   = enunciado[:40].strip().lower()

            matched_id = None
            for ex in db_exercises:
                db_stmt = (ex.get("statement") or "").strip().lower()
                if snippet and snippet[:20] in db_stmt:
                    matched_id = str(ex.get("id") or ex.get("_id") or "")
                    break

            if matched_id:
                self.exercise_map[ex_num] = matched_id
                print(f"    Ex {ex_num} -> {matched_id}")
            else:
                print(f"    [WARN] Exercise {ex_num}: no DB match  (looking for: {snippet[:40]!r})")

        if not self.exercise_map:
            print("\n  Available DB exercises:")
            for ex in db_exercises:
                eid  = ex.get("id") or ex.get("_id")
                stmt = (ex.get("statement") or "")[:60]
                print(f"    {eid}: {stmt!r}")
            raise RuntimeError(
                "Could not map any benchmark exercises to DB exercises. "
                "Use --exercise-map '{\"1\": \"<db_id>\", ...}' to specify manually."
            )

    def set_exercise_map(self, mapping: Dict[str, str]) -> None:
        """
           IN -> dict ____|____________________
                      | set_exercise_map() | -> void   (writes exercise_map (dict))
                       --------------------
           Manually sets exercise_map from a {str(number): db_id} dict.
        """
        self.exercise_map = {int(k): v for k, v in mapping.items()}

    def stream_chat(
        self,
        db_exercise_id: str,
        user_message:   str,
        interaccion_id: Optional[str] = None,
    ) -> Tuple[str, Optional[str], float, int]:
        """
           IN -> Txt, Txt, Txt | null ____|________________
                                      | stream_chat() | -> (Txt, Txt | null, R, Z)
                                       ----------------
           Calls POST /api/ollama/chat/stream, parses the SSE stream and
           returns (tutor_text, interaccion_id, latency_s, token_estimate);
           pass the previous interaccion_id to continue the conversation.
        """
        url     = f"{self.base_url}/api/ollama/chat/stream"
        payload: Dict[str, Any] = {
            "exerciseId":  db_exercise_id,
            "userMessage": user_message,
        }
        if interaccion_id:
            payload["interaccionId"] = interaccion_id

        start   = time.time()
        new_iid: Optional[str] = interaccion_id

        try:
            resp = self.session.post(url, json=payload, stream=True, timeout=180)
            if resp.status_code != 200:
                latency = time.time() - start
                print(f"  HTTP {resp.status_code}: {resp.text[:200]}")
                return "", new_iid, latency, 0

            full_text = ""
            for raw_line in resp.iter_lines(decode_unicode=True):
                if raw_line is None:
                    continue
                if raw_line.startswith(": "):
                    continue
                if not raw_line.startswith("data: "):
                    continue

                data_str = raw_line[6:]
                if data_str == "[DONE]":
                    break

                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                if "error" in chunk:
                    print(f"  [BackendClient] SSE error: {chunk['error']}")
                    break

                if "interaccionId" in chunk:
                    new_iid = chunk["interaccionId"]
                    continue

                if "chunk" in chunk:
                    piece = chunk["chunk"]
                    if chunk.get("replace"):
                        full_text = piece
                    else:
                        full_text = full_text + piece

            latency        = time.time() - start
            token_estimate = max(1, int(len(full_text.split()) * 1.3))
            return full_text.strip(), new_iid, latency, token_estimate

        except Exception as error:
            latency = time.time() - start
            print(f"  [BackendClient] stream_chat error: {error}")
            return "", new_iid, latency, 0

    def check(self) -> bool:
        """
           IN -> ____|_______
                | check() | -> T/F   (reads base_url (Txt), session (Obj))
                 ---------
           Returns True when GET /api/ejercicios responds with status 200.
        """
        try:
            resp = self.session.get(f"{self.base_url}/api/ejercicios", timeout=5)
            return resp.status_code == 200
        except Exception:
            return False


def extract_think(raw_text: str) -> Tuple[str, str]:
    """
       IN -> Txt ____|_________________
                 | extract_think() | -> (Txt, Txt)
                  -----------------
       Splits the raw model output into the <think>...</think> reasoning and
       the clean socratic response (think_content, tutor_response).
    """
    match = re.search(r"<think>(.*?)</think>", raw_text, re.DOTALL)
    if match:
        think_content = match.group(1).strip()
        clean_response = re.sub(r"<think>.*?</think>", "", raw_text, flags=re.DOTALL).strip()
        return think_content, clean_response
    return "", raw_text


AC_KEYWORDS: Dict[str, List[str]] = {
    "AC1":  ["interruptor", "abierto", "circuito abierto", "sin camino",
             "corriente cero", "desconecta", "no circula", "rama abierta"],
    "AC2":  ["atenuación", "señal", "intensidad baja", "cae la corriente"],
    "AC6":  ["cortocircuito", "cable directo", "resistencia cero",
             "en paralelo con un cable", "anula", "evita el paso"],
    "AC9":  ["global", "camino completo", "visión global",
             "todas las resistencias", "sin tener en cuenta"],
    "AC13": ["confunde voltaje", "confunde corriente", "diferencia entre tensión",
             "tensión e intensidad"],
    "AC14": ["serie", "paralelo", "topología", "conexión directa"],
}


def detect_acs_in_response(response: str, ac_patterns: List[Dict]) -> List[str]:
    """
       IN -> Txt, [Dict] ____|___________________________
                         | detect_acs_in_response() | -> [Txt]
                          ---------------------------
       Returns the ACs the tutor addresses, considering an AC covered when
       at least 2 of its (fixed + dynamic) keywords appear in the response.
    """
    response_lower = response.lower()
    detected_list = []

    for pattern in ac_patterns:
        ac_id    = pattern["id"]
        strategy = pattern.get("strategy", "").lower()
        misc     = pattern.get("misconception", "").lower()

        fixed_keywords = AC_KEYWORDS.get(ac_id, [])

        combined_text = strategy + " " + misc
        all_words = combined_text.split()
        dynamic_keywords = []
        for word in all_words:
            cleaned_word = word.strip(".,;:()")
            if len(cleaned_word) >= 5:
                dynamic_keywords.append(cleaned_word)

        all_keywords = fixed_keywords + dynamic_keywords

        hit_count = 0
        for keyword in all_keywords:
            if keyword in response_lower:
                hit_count = hit_count + 1

        if hit_count >= 2:
            detected_list.append(ac_id)

    return detected_list


def evaluate_socraticidad(response: str) -> Tuple[int, str]:
    """
       IN -> Txt ____|________________________
                 | evaluate_socraticidad() | -> (Z, Txt)
                  --------------------------
       Scores the socratic quality 1-5 (instructive, closed question,
       clarification, scaffolding, induction to contradiction) and returns
       the score with a justification.
    """
    if not response or not response.strip():
        return 1, "Empty response"

    resp = response.strip()
    resp_lower = resp.lower()
    ends_with_question = resp.endswith("?")

    direct_patterns = [
        r"\bla respuesta (correcta )?es\b", r"\bla solución es\b",
        r"\bdebes usar\b", r"\btienes que (usar|incluir|considerar)\b",
        r"\bel resultado es\b", r"\bsimplemente\b",
        r"\b(correcto|excelente|perfecto|bien hecho)\b",
    ]
    gives_direct_answer = False
    for pattern in direct_patterns:
        if re.search(pattern, resp_lower):
            gives_direct_answer = True
            break

    if not ends_with_question:
        return 1, "Does not end with a question; the tutor is instructive"
    if gives_direct_answer:
        return 1, "Gives the answer directly before asking"

    contradiction_patterns = [
        r"si (siguieras|usaras|mantuvieras|aplicaras).{0,50}¿qué",
        r"¿(podría|sería posible).{0,40}si\b",
        r"¿si.{0,60}qué (ocurri|pasaría|sucedería)",
        r"¿qué pasaría si.{0,50}(siguieras|aplicaras|mantuvieras)",
        r"lleva(ría)? al absurdo",
        r"reducción al absurdo",
        r"contraejemplo",
        r"¿(es|sería) (físicamente )?posible que",
        r"¿cómo explicarías.{0,30}si.{0,30}(no|no puede)",
    ]
    for pattern in contradiction_patterns:
        if re.search(pattern, resp_lower):
            return 5, "Induction to contradiction: uses counterexample or reduction to absurdity"

    scaffold_patterns = [
        r"¿qué (pasa|ocurre|sucede) (con|cuando|si)\b",
        r"¿cómo (afecta|influye|cambia)\b",
        r"¿qué (implica|significa) que\b",
        r"¿has (revisado|comprobado|considerado).{0,30}(circuito|nodo|camino)",
        r"¿circula (corriente|tensión)\b",
        r"¿por qué (crees|piensas|afirmas).{0,40}"
        r"(resistencia|corriente|tensión|nodo|circuito|interruptor)",
    ]
    circuit_term_patterns = [
        r"interruptor", r"cortocircuito", r"nodo [n]?\d", r"\ben serie\b",
        r"\ben paralelo\b", r"\br\d\b", r"camino eléctrico",
    ]

    has_scaffold = False
    for pattern in scaffold_patterns:
        if re.search(pattern, resp_lower):
            has_scaffold = True
            break

    has_circuit_terms = False
    for pattern in circuit_term_patterns:
        if re.search(pattern, resp_lower):
            has_circuit_terms = True
            break

    if has_scaffold and has_circuit_terms:
        return 4, ("Scaffolding for detection: identifies the error area "
                   "and asks a question that confronts the theory")

    closed_patterns = [
        r"¿no (es|crees|sería|tienes)\b",
        r"¿verdad\s*\?$", r"¿correcto\s*\?$", r"¿sí\s*\?$", r"¿no\s*\?$",
        r"¿no ves que\b", r"¿no te parece que\b",
    ]
    for pattern in closed_patterns:
        if re.search(pattern, resp_lower):
            return 2, "Closed question: the answer is already implicit in the question"

    clarify_patterns = [
        r"¿por qué (crees|piensas|dices|afirmas)\b",
        r"¿puedes (explicar|describir|elaborar|detallar)\b",
        r"¿cómo (llegaste|obtuviste|calculaste)\b",
        r"¿qué razonamiento\b",
        r"¿podrías (explicar|detallar|ampliar)\b",
        r"¿qué te (llevó|hizo) (pensar|creer)\b",
    ]
    for pattern in clarify_patterns:
        if re.search(pattern, resp_lower):
            return 3, "Clarification: asks the student to explain their reasoning"

    return 3, "Generic question: asks for clarification without attacking the root error"


def evaluate_precision_conceptual(
    response: str,
    expected_acs: List[str],
    ac_patterns: List[Dict],
    student_answer: str,
) -> Tuple[int, str]:
    """
       IN -> Txt, [Txt], [Dict], Txt ____|________________________________
                                     | evaluate_precision_conceptual() | -> (Z, Txt)
                                      ----------------------------------
       Scores the conceptual precision 1-5 (unacceptable, poor, sufficient,
       good, excellent) from vocabulary, AC coverage and topology cues, and
       returns the score with a justification.
    """
    if not response or not response.strip():
        return 1, "Empty response"

    response_lower = response.lower()

    validation_patterns = [
        r"\b(correcto|excelente|perfecto|bien hecho|has acertado)\b",
        r"(la respuesta correcta es|estás (en lo )?correcto|has identificado bien)",
    ]
    physics_error_patterns = [
        r"corriente.{0,25}(pasa|circula).{0,20}circuito abierto",
        r"cortocircuito.{0,20}resistencia (alta|grande)",
        r"resistencia.{0,20}negativa",
    ]

    all_bad_patterns = validation_patterns + physics_error_patterns
    for pattern in all_bad_patterns:
        if re.search(pattern, response_lower):
            return 1, "Validates incorrect answer or makes serious physics error"

    tech_vocab_list = [
        "resistencia", "corriente", "tensión", "voltaje", "nodo",
        "interruptor", "circuito abierto", "cortocircuito",
        "serie", "paralelo", "camino", "netlist", "diferencia de potencial",
    ]
    vocab_hits = 0
    for vocab_word in tech_vocab_list:
        if vocab_word in response_lower:
            vocab_hits = vocab_hits + 1

    if vocab_hits == 0:
        return 2, "Generic response: no technical vocabulary or error diagnosis"

    ac_concepts: Dict[str, List[str]] = {
        "AC1":  ["circuito abierto", "interruptor", "sin camino", "no circula", "rama"],
        "AC2":  ["atenuación", "señal"],
        "AC6":  ["cortocircuito", "paralelo con un cable", "resistencia cero", "evita"],
        "AC9":  ["global", "camino completo", "todas las resistencias", "sin tener en cuenta"],
        "AC13": ["voltaje", "corriente", "diferencia entre"],
        "AC14": ["serie", "paralelo", "topología"],
    }

    addressed_count = 0
    for ac_id in expected_acs:
        keywords_for_ac = ac_concepts.get(ac_id, [])
        for keyword in keywords_for_ac:
            if keyword in response_lower:
                addressed_count = addressed_count + 1
                break

    if len(expected_acs) > 0:
        address_ratio = addressed_count / len(expected_acs)
    else:
        address_ratio = 1.0

    topology_patterns = [
        r"nodo [n]?\d", r"entre n\d y [n0]?\d",
        r"camino (eléctrico|desde|hasta)",
        r"los (dos )?terminales", r"mismos? nud?o",
        r"en paralelo con un cable",
        r"topología", r"netlist",
        r"estructura del circuito",
    ]
    has_topology = False
    for pattern in topology_patterns:
        if re.search(pattern, response_lower):
            has_topology = True
            break

    resistors_in_response = re.findall(r"\br\d\b", response_lower)

    if address_ratio >= 0.7 and has_topology and resistors_in_response:
        return 5, ("Excellent: identifies the specific alternative conception "
                   "and connects it with the circuit topology")

    if address_ratio >= 0.5 and vocab_hits >= 3:
        return 4, ("Good: clearly identifies the alternative conception "
                   "with precise technical language")

    if vocab_hits >= 2:
        return 3, ("Sufficient: identifies that there is an error and uses correct concepts, "
                   "but the diagnosis is somewhat vague")

    return 2, "Poor: responds generically without diagnosing the conceptual error"


def evaluate_consistencia(response: str, student_answer: str) -> Tuple[int, str]:
    """
       IN -> Txt, Txt ____|_______________________
                      | evaluate_consistencia() | -> (Z, Txt)
                       --------------------------
       Scores 1-5 how well the response is calibrated to the student answer
       (length ratio and shared resistor mentions) and returns the score
       with a justification.
    """
    if not response or not student_answer:
        return 1, "Empty input or response"

    student_word_count = len(student_answer.split())
    response_word_count = len(response.split())

    max_student_words = max(student_word_count, 1)
    ratio = response_word_count / max_student_words

    student_resistors = set(re.findall(r"\br\d\b", student_answer.lower()))
    response_resistors = set(re.findall(r"\br\d\b", response.lower()))

    if len(student_resistors) > 0:
        common_resistors = student_resistors & response_resistors
        overlap = len(common_resistors) / len(student_resistors)
    else:
        overlap = 0.5

    if ratio > 7 or ratio < 0.15:
        return 2, f"Disproportionate response (ratio={ratio:.1f} tutor/student words)"

    if overlap >= 0.8 and ratio >= 0.5 and ratio <= 3.5:
        return 5, "Perfect calibration: references exactly what the student said"

    if overlap >= 0.5 and ratio <= 4.5:
        return 4, "Good consistency: appropriately references the student answer"

    if overlap > 0 or ratio <= 4:
        return 3, "Partial consistency: addresses something the student said"

    return 2, "Low consistency: does not reference what the student mentioned"


def evaluate_tasa_alucinacion(response: str, exercise_context: str) -> Tuple[int, str]:
    """
       IN -> Txt, Txt ____|__________________________
                      | evaluate_tasa_alucinacion() | -> (Z, Txt)
                       ------------------------------
       Scores factual correctness 1-5 (5 = no hallucinations) by detecting
       invented resistors and serious/minor physics errors, and returns the
       score with a justification.
    """
    if not response:
        return 3, "Empty response, not evaluable"

    response_lower  = response.lower()
    context_lower = exercise_context.lower()

    context_resistors  = set(re.findall(r"\br\d\b", context_lower))
    response_resistors = set(re.findall(r"\br\d\b", response_lower))

    if context_resistors:
        invented_resistors = response_resistors - context_resistors
    else:
        invented_resistors = set()

    serious_patterns = [
        r"\br[89]\b", r"\br10\b", r"\br11\b",
        r"corriente.{0,25}infinita",
        r"resistencia.{0,20}negativa",
        r"(fórmula|ecuación).{0,15}(incorrecta|errónea)",
        r"cortocircuito.{0,20}resistencia (alta|grande|infinita)",
    ]
    is_serious = False
    for pattern in serious_patterns:
        if re.search(pattern, response_lower):
            is_serious = True
            break
    if len(invented_resistors) >= 2:
        is_serious = True

    minor_patterns = [
        r"el voltaje de la resistencia",
        r"amperios en la resistencia",
    ]
    has_minor = False
    for pattern in minor_patterns:
        if re.search(pattern, response_lower):
            has_minor = True
            break

    if is_serious:
        if invented_resistors:
            extra_info = f" (invented R: {invented_resistors})"
        else:
            extra_info = ""
        return 1, f"Serious hallucination: mentions components/physics not present{extra_info}"

    if len(invented_resistors) == 1:
        return 2, f"Notable inaccuracy: mentions {invented_resistors} which does not appear in the exercise"

    if has_minor:
        return 4, "Minor nomenclature imprecision without conceptual impact"

    return 5, "No hallucinations detected: factually correct response"


def compute_cot_faithfulness(think_content: str, response: str) -> float:
    """
       IN -> Txt, Txt ____|___________________________
                      | compute_cot_faithfulness() | -> R
                       ----------------------------
       Returns the fraction of circuit keywords in the reasoning that also
       appear in the final response (0.5 when the reasoning is empty).
    """
    keywords_pattern = r"r\d|serie|paralelo|corriente|tensión|nodo|interruptor|cortocircuito"
    think_keywords = set(re.findall(keywords_pattern, think_content.lower()))
    response_keywords = set(re.findall(keywords_pattern, response.lower()))

    if len(think_keywords) > 0:
        common_keywords = think_keywords & response_keywords
        return len(common_keywords) / len(think_keywords)
    return 0.5


def compute_cot_relevance(think_content: str, student_answer: str) -> float:
    """
       IN -> Txt, Txt ____|________________________
                      | compute_cot_relevance() | -> R
                       -------------------------
       Returns the fraction of circuit keywords in the student answer that
       also appear in the reasoning (0.5 when the answer has none).
    """
    keywords_pattern = r"r\d|serie|paralelo|cortocircuito|abierto"
    student_keywords = set(re.findall(keywords_pattern, student_answer.lower()))
    think_keywords   = set(re.findall(keywords_pattern, think_content.lower()))

    if len(student_keywords) > 0:
        common_keywords = student_keywords & think_keywords
        return len(common_keywords) / len(student_keywords)
    return 0.5


SOCRATIC_LABELS = {
    1: "Instructive",
    2: "Closed questions",
    3: "Clarification",
    4: "Scaffolding for detection",
    5: "Induction to contradiction",
}
PRECISION_LABELS = {
    1: "Unacceptable",
    2: "Poor",
    3: "Sufficient",
    4: "Good",
    5: "Excellent",
}


def build_feedback(
    socratic_score: int,
    precision_score: int,
    consistency_score: int,
    hallucination_score: int,
    socratic_reason: str,
    precision_reason: str,
) -> str:
    """
       IN -> Z, Z, Z, Z, Txt, Txt ____|__________________
                                  | build_feedback() | -> Txt
                                   ------------------
       Builds a constructive feedback string from the four pedagogical
       scores and an overall-performance band based on their total.
    """
    total = socratic_score + precision_score + consistency_score + hallucination_score

    socratic_label = SOCRATIC_LABELS.get(socratic_score, "")
    precision_label = PRECISION_LABELS.get(precision_score, "")

    feedback = (
        f"Socratic quality {socratic_score}/5 ({socratic_label}): {socratic_reason}. "
        f"Conceptual precision {precision_score}/5 ({precision_label}): {precision_reason}."
    )

    if total >= 17:
        feedback = feedback + " High-performing tutor: expert socratic guidance with precise diagnosis."
    elif total >= 13:
        feedback = feedback + " Good overall performance; room for improvement in socratic depth."
    elif total >= 9:
        feedback = feedback + " Acceptable performance; needs to improve precision or socratic methodology."
    else:
        feedback = feedback + " Low performance; instructive responses or incorrect diagnosis."

    return feedback


def build_rag_prompt(student_answer: str, context: str) -> str:
    """
       IN -> Txt, Txt ____|___________________
                      | build_rag_prompt() | -> Txt
                       --------------------
       Builds the RAG prompt that joins the retrieved context, the student
       answer and the instruction to emit one brief socratic question.
    """
    separator = "-" * 60
    prompt = (
        f"{context}\n\n"
        f"{separator}\n"
        f"STUDENT ANSWER:\n{student_answer}\n\n"
        f"Generate ONE brief socratic question (maximum 2 sentences) that guides "
        f"the student without revealing the correct answer. "
        f"The question MUST end with ?."
    )
    return prompt


class RagBenchmark:
    """
            _________________________________________________________
            |                     RAGBENCHMARK                      |
            |  Orchestrates the benchmark: loads datasets, drives    |
            |  the backend RAG pipeline per turn and scores every    |
            |  response. RagKnowledgeBase is used only for           |
            |  evaluation (expected ACs, hallucination check).       |
        ____|________________________                                |
   Path, Txt -> | __init__() | -> void   (writes kb (RagKnowledgeBase),|
                ------------               data_dir (Path), backend_url (Txt))|
        ____|________________                                        |
        | load_dataset() | -> [Dict]                                 |
        -----------------                                            |
        ____|_______                                                 |
        | run() | -> [EvalResult]                                    |
        --------                                                     |
            |________________________________________________________|
    """

    def __init__(self, data_dir: Path, backend_url: str = BACKEND_URL):
        """
           IN -> Path, Txt ____|___________
                           | __init__() | -> void   (writes kb (RagKnowledgeBase), data_dir (Path), backend_url (Txt))
                            ------------
           Initializes the benchmark with its knowledge base, data directory
           and backend URL.
        """
        self.kb          = RagKnowledgeBase(data_dir)
        self.data_dir    = data_dir
        self.backend_url = backend_url

    def load_dataset(self, exercise_id: int) -> List[Dict]:
        """
           IN -> Z ____|_______________
                  | load_dataset() | -> [Dict]   (reads data_dir (Path))
                   -----------------
           Loads the dataset for an exercise and normalizes field names,
           supporting both 'student'/'alumno' and 'tutor'.
        """
        file_path = self.data_dir / "datasets" / f"dataset_exercise_{exercise_id}.json"
        if not file_path.exists():
            print(f"  [WARN] Dataset not found: {file_path}")
            return []

        with open(file_path, encoding="utf-8") as f:
            raw_data = json.load(f)

        result = []
        for item in raw_data:
            student_text = item.get("student") or item.get("alumno", "")
            tutor_text   = item.get("tutor", "")
            if student_text and tutor_text:
                result.append({"student": student_text.strip(), "tutor": tutor_text.strip()})
        return result

    def run(
        self,
        models: List[str] = None,
        exercises: List[int] = None,
        max_per_exercise: Optional[int] = None,
        turns: int = 3,
        exercise_map: Optional[Dict[str, str]] = None,
    ) -> List[EvalResult]:
        """
           IN -> [Txt], [Z], Z, Z, dict ____|_______
                                        | run() | -> [EvalResult]   (reads kb, backend_url)
                                         --------
           Runs the full benchmark: logs in, maps exercises, groups dataset
           cases into conversations, drives every turn through the backend
           pipeline and returns all scored EvalResult items.
        """

        if models is None:
            models = ["qwen2.5:latest"]
        if exercises is None:
            exercises = ALL_EXERCISES

        backend = BackendClient(self.backend_url)
        print(f"\n  Checking backend at {self.backend_url} ...")
        if not backend.check():
            print(f"  [WARN] Backend not reachable at {self.backend_url} — continuing anyway")

        backend.login()

        if exercise_map:
            backend.set_exercise_map(exercise_map)
        else:
            bench_enunciados: Dict[int, str] = {}
            for ex_id in exercises:
                bench_enunciados[ex_id] = self.kb.get_enunciado(ex_id)
            backend.load_exercises(exercises, bench_enunciados)

        all_results: List[EvalResult] = []
        global_sample_id     = 0
        conversation_counter = 0

        print(f"\n{'=' * 70}")
        print(f"  RAG BENCHMARK  (backend={self.backend_url}, turns/conv={turns})")
        print(f"  Models   : {models}")
        print(f"  Exercises: {exercises}")
        print(f"{'=' * 70}\n")

        for model_name in models:
            print(f"\n{'-' * 70}")
            print(f"  Model: {model_name}  ->  via backend RAG pipeline")
            print(f"{'-' * 70}")

            for exercise_id in exercises:
                db_exercise_id = backend.exercise_map.get(exercise_id)
                if not db_exercise_id:
                    print(f"  [SKIP] Exercise {exercise_id}: no DB ID mapped")
                    continue

                dataset = self.load_dataset(exercise_id)

                if max_per_exercise is not None:
                    dataset = dataset[:max_per_exercise]

                if not dataset:
                    continue

                exercise_context = self.kb.retrieve(exercise_id)
                ac_patterns      = self.kb.get_ac_patterns(exercise_id)

                groups = []
                index  = 0
                while index < len(dataset):
                    group = dataset[index:index + turns]
                    groups.append(group)
                    index = index + turns

                print(f"\n  Exercise {exercise_id}  (DB: {db_exercise_id})  "
                      f"({len(dataset)} cases -> {len(groups)} convs x {turns} turns)")

                for group in groups:
                    conversation_counter = conversation_counter + 1
                    current_iid: Optional[str] = None

                    turn_index = 0
                    for sample in group:
                        student_answer = sample["student"]
                        expected_tutor = sample["tutor"]
                        global_sample_id = global_sample_id + 1
                        turn_number      = turn_index + 1

                        print(f"    Conv {conversation_counter:>2} | Turn {turn_number}/{len(group)}  ",
                              end="", flush=True)

                        expected_acs = self.kb.expected_acs_for(exercise_id, student_answer)

                        raw_response, current_iid, latency, token_count = backend.stream_chat(
                            db_exercise_id=db_exercise_id,
                            user_message=student_answer,
                            interaccion_id=current_iid,
                        )

                        if latency > 0:
                            throughput = 60 / latency
                        else:
                            throughput = 0

                        print(f"lat={latency:.1f}s  tok={token_count}  tput={throughput:.1f}/min")

                        if not raw_response:
                            print("    [WARN] Empty response, skipping turn")
                            turn_index = turn_index + 1
                            continue

                        think_content, tutor_response = extract_think(raw_response)

                        detected_acs    = detect_acs_in_response(tutor_response, ac_patterns)
                        expected_set    = set(expected_acs)
                        detected_set    = set(detected_acs)
                        true_positives  = sorted(expected_set & detected_set)
                        false_positives = sorted(detected_set - expected_set)
                        false_negatives = sorted(expected_set - detected_set)

                        if len(detected_set) > 0:
                            ac_precision = len(true_positives) / len(detected_set)
                        else:
                            ac_precision = 1.0

                        if len(expected_set) > 0:
                            ac_recall = len(true_positives) / len(expected_set)
                        else:
                            ac_recall = 1.0

                        if (ac_precision + ac_recall) > 0:
                            ac_f1 = 2 * ac_precision * ac_recall / (ac_precision + ac_recall)
                        else:
                            ac_f1 = 0.0

                        socratic_score,    socratic_reason    = evaluate_socraticidad(tutor_response)
                        precision_score,   precision_reason   = evaluate_precision_conceptual(
                            tutor_response, expected_acs, ac_patterns, student_answer
                        )
                        consistency_score, consistency_reason = evaluate_consistencia(
                            tutor_response, student_answer
                        )
                        hallucination_score, hallucination_reason = evaluate_tasa_alucinacion(
                            tutor_response, exercise_context
                        )
                        total_score = (socratic_score + precision_score
                                       + consistency_score + hallucination_score)

                        if think_content:
                            faithfulness_score = compute_cot_faithfulness(think_content, tutor_response)
                            relevance_score    = compute_cot_relevance(think_content, student_answer)
                        else:
                            faithfulness_score = None
                            relevance_score    = None

                        feedback_text = build_feedback(
                            socratic_score, precision_score,
                            consistency_score, hallucination_score,
                            socratic_reason, precision_reason,
                        )

                        new_result = EvalResult(
                            model=model_name,
                            ejercicio=exercise_id,
                            sample_id=global_sample_id,
                            conversation_id=conversation_counter,
                            turn=turn_number,
                            student_answer=student_answer,
                            expected_tutor=expected_tutor,
                            expected_acs=expected_acs,
                            retrieved_context=exercise_context,
                            rag_prompt="[via backend API]",
                            model_response=raw_response,
                            think_content=think_content,
                            tutor_response=tutor_response,
                            latencia=latency,
                            tokens_generados=token_count,
                            detected_acs=detected_acs,
                            true_positives=true_positives,
                            false_positives=false_positives,
                            false_negatives=false_negatives,
                            ac_precision=ac_precision,
                            ac_recall=ac_recall,
                            ac_f1=ac_f1,
                            socraticidad=socratic_score,
                            precision_conceptual=precision_score,
                            consistencia=consistency_score,
                            tasa_alucinacion=hallucination_score,
                            score_total=total_score,
                            faithfulness=faithfulness_score,
                            relevance=relevance_score,
                            feedback_constructivo=feedback_text,
                            timestamp=datetime.now().isoformat(),
                        )
                        all_results.append(new_result)
                        turn_index = turn_index + 1

        return all_results


def save_json(results: List[EvalResult], out_dir: Path, timestamp_str: str) -> Path:
    """
       IN -> [EvalResult], Path, Txt ____|_____________
                                     | save_json() | -> Path
                                      -------------
       Writes all results plus run metadata to a timestamped JSON file and
       returns its path.
    """
    models_set = set()
    exercises_set = set()
    for result in results:
        models_set.add(result.model)
        exercises_set.add(result.ejercicio)

    result_dicts = []
    for result in results:
        result_dicts.append(result.to_dict())

    payload = {
        "benchmark_id":      f"rag_benchmark_{timestamp_str}",
        "method":            "RAG",
        "timestamp":         datetime.now().isoformat(),
        "models_tested":     sorted(models_set),
        "exercises_covered": sorted(exercises_set),
        "total_evaluations": len(results),
        "results":           result_dicts,
    }

    file_path = out_dir / f"rag_benchmark_{timestamp_str}.json"
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, default=str)
    print(f"  JSON saved -> {file_path}")
    return file_path


def compute_model_stats(results: List[EvalResult], model_name: str) -> Dict:
    """
       IN -> [EvalResult], Txt ____|_______________________
                               | compute_model_stats() | -> Dict
                                ------------------------
       Aggregates the efficiency, pedagogical and CoT statistics for a
       single model across all its results.
    """
    model_results = []
    for result in results:
        if result.model == model_name:
            model_results.append(result)

    latencies = []
    for result in model_results:
        latencies.append(result.latencia)

    token_counts = []
    for result in model_results:
        token_counts.append(result.tokens_generados)

    faithfulness_values = []
    for result in model_results:
        if result.faithfulness is not None:
            faithfulness_values.append(result.faithfulness)

    relevance_values = []
    for result in model_results:
        if result.relevance is not None:
            relevance_values.append(result.relevance)

    socratic_scores = []
    for result in model_results:
        socratic_scores.append(result.socraticidad)

    precision_scores = []
    for result in model_results:
        precision_scores.append(result.precision_conceptual)

    consistency_scores = []
    for result in model_results:
        consistency_scores.append(result.consistencia)

    hallucination_scores = []
    for result in model_results:
        hallucination_scores.append(result.tasa_alucinacion)

    total_scores = []
    for result in model_results:
        total_scores.append(result.score_total)

    socratic_high_count = 0
    for result in model_results:
        if result.socraticidad >= 4:
            socratic_high_count = socratic_high_count + 1

    high_score_count = 0
    for result in model_results:
        if result.score_total >= 15:
            high_score_count = high_score_count + 1

    cot_count = 0
    for result in model_results:
        if result.think_content:
            cot_count = cot_count + 1

    sample_count = len(model_results)
    avg_latency = float(np.mean(latencies))

    if avg_latency > 0:
        throughput = 60.0 / avg_latency
    else:
        throughput = 0.0

    if faithfulness_values:
        avg_faithfulness = float(np.mean(faithfulness_values))
    else:
        avg_faithfulness = None

    if relevance_values:
        avg_relevance = float(np.mean(relevance_values))
    else:
        avg_relevance = None

    if sample_count > 0:
        pct_socratic = socratic_high_count / sample_count * 100
        pct_score_15 = high_score_count / sample_count * 100
        pct_cot      = cot_count / sample_count * 100
    else:
        pct_socratic = 0.0
        pct_score_15 = 0.0
        pct_cot      = 0.0

    return {
        "muestras":             sample_count,
        "latencia_media":       avg_latency,
        "latencia_p95":         float(np.percentile(latencies, 95)),
        "throughput":           throughput,
        "tokens_medio":         float(np.mean(token_counts)),
        "formato_socratico":    float(np.mean(socratic_scores)),
        "correccion_conceptual":float(np.mean(precision_scores)),
        "adaptabilidad":        float(np.mean(consistency_scores)),
        "generacion_reflexion": float(np.mean(hallucination_scores)),
        "score_total":          float(np.mean(total_scores)),
        "pct_socratico":        pct_socratic,
        "pct_score_15":         pct_score_15,
        "faithfulness":         avg_faithfulness,
        "relevance":            avg_relevance,
        "pct_cot":              pct_cot,
    }


def build_sheet_name(model_name: str) -> str:
    """
       IN -> Txt ____|____________________
                 | build_sheet_name() | -> Txt
                  --------------------
       Returns a safe Excel sheet name for a model (special chars replaced,
       prefixed with Results_, truncated to fit).
    """
    safe_name = model_name.replace(":", "_").replace("/", "_")
    return "Results_" + safe_name[:28]


def build_formula_range(model_name: str, column_letter: str, max_row: int) -> str:
    """
       IN -> Txt, Txt, Z ____|______________________
                         | build_formula_range() | -> Txt
                          ------------------------
       Returns an Excel formula range string like 'SheetName'!A2:A10000 for
       the given model column.
    """
    sheet_name = build_sheet_name(model_name)
    return f"'{sheet_name}'!{column_letter}2:{column_letter}{max_row}"


def save_xlsx(results: List[EvalResult], out_dir: Path, timestamp_str: str) -> Path:
    """
       IN -> [EvalResult], Path, Txt ____|_____________
                                     | save_xlsx() | -> Path
                                      -------------
       Writes the 7-sheet XLSX report (per-model data, metadata, ranking,
       article results, efficiency, CoT) with Excel formulas and returns
       its path.
    """
    file_path = out_dir / f"rag_benchmark_{timestamp_str}.xlsx"

    models_set = set()
    exercises_set = set()
    for result in results:
        models_set.add(result.model)
        exercises_set.add(result.ejercicio)
    models    = sorted(models_set)
    exercises = sorted(exercises_set)

    architecture_map = {
        "qwen2.5:latest": "RAG",
    }

    MAX_ROW = 10000

    COLUMNS = {
        "id":    "A", "conv":  "B", "turn":  "C", "ex":   "D",
        "est":   "E", "tut":   "F",
        "socr":  "G", "prec":  "H", "cons":  "I", "aluc": "J",
        "score": "K", "lat":   "L", "tok":   "M", "tput": "N",
        "ac_e":  "O", "ac_d":  "P", "ac_p":  "Q", "ac_r": "R", "ac_f": "S",
        "faith": "T", "relev": "U", "think": "V", "fb":   "W",
    }

    with pd.ExcelWriter(str(file_path), engine="openpyxl") as writer:

        for model_name in models:
            rows = []
            for result in results:
                if result.model != model_name:
                    continue

                if result.latencia > 0:
                    throughput_value = round(60 / result.latencia, 2)
                else:
                    throughput_value = 0

                row = {
                    "ID":                        result.sample_id,
                    "Conversation":              result.conversation_id,
                    "Turn":                      result.turn,
                    "Exercise":                  result.ejercicio,
                    "Student Answer":            result.student_answer,
                    "Tutor Socratic Response":   result.tutor_response,
                    "Socratic Quality":          result.socraticidad,
                    "Conceptual Precision":      result.precision_conceptual,
                    "Consistency":               result.consistencia,
                    "Hallucination Rate":        result.tasa_alucinacion,
                    "Total Score":               result.score_total,
                    "Latency (s)":               round(result.latencia, 3),
                    "Tokens":                    result.tokens_generados,
                    "Throughput (resp/min)":     throughput_value,
                    "Expected ACs":              ", ".join(result.expected_acs),
                    "Detected ACs":              ", ".join(result.detected_acs),
                    "AC Precision":              round(result.ac_precision, 3),
                    "AC Recall":                 round(result.ac_recall, 3),
                    "AC F1":                     round(result.ac_f1, 3),
                    "Faithfulness":              result.faithfulness,
                    "Relevance":                 result.relevance,
                    "Think Content":             result.think_content or "",
                    "Constructive Feedback":     result.feedback_constructivo,
                }
                rows.append(row)

            sheet_name = build_sheet_name(model_name)
            pd.DataFrame(rows).to_excel(writer, sheet_name=sheet_name, index=False)

        exercises_str = []
        for exercise_id in exercises:
            exercises_str.append(str(exercise_id))

        meta_rows = [
            {"Field": "Generation date",   "Value": datetime.now().isoformat()},
            {"Field": "Method",            "Value": "RAG (via backend API)"},
            {"Field": "Models evaluated",  "Value": ", ".join(models)},
            {"Field": "Exercises covered", "Value": ", ".join(exercises_str)},
            {"Field": "Total evaluations", "Value": len(results)},
            {"Field": "Backend URL",       "Value": BACKEND_URL},
        ]
        pd.DataFrame(meta_rows).to_excel(writer, sheet_name="Metadata", index=False)

        workbook = writer.book

        all_model_stats = {}
        for model_name in models:
            all_model_stats[model_name] = compute_model_stats(results, model_name)

        score_and_model_pairs = []
        for model_name in models:
            model_score = all_model_stats[model_name]["score_total"]
            score_and_model_pairs.append((model_score, model_name))
        score_and_model_pairs.sort(reverse=True)
        ranked_models = []
        for score_value, model_name in score_and_model_pairs:
            ranked_models.append(model_name)

        ranking_sheet = workbook.create_sheet("Ranking")
        ranking_sheet.append([
            "Ranking", "Model", "samples",
            "avg_latency", "p95_latency", "throughput", "avg_tokens",
            "socratic_format", "conceptual_correctness", "adaptability", "reflection_generation",
            "score_total", "pct_socratic", "pct_score_15",
            "faithfulness", "relevance", "pct_cot",
        ])

        rank_number = 1
        for model_name in ranked_models:
            lat_range   = build_formula_range(model_name, COLUMNS["lat"],   MAX_ROW)
            tok_range   = build_formula_range(model_name, COLUMNS["tok"],   MAX_ROW)
            score_range = build_formula_range(model_name, COLUMNS["score"], MAX_ROW)
            socr_range  = build_formula_range(model_name, COLUMNS["socr"],  MAX_ROW)
            prec_range  = build_formula_range(model_name, COLUMNS["prec"],  MAX_ROW)
            cons_range  = build_formula_range(model_name, COLUMNS["cons"],  MAX_ROW)
            aluc_range  = build_formula_range(model_name, COLUMNS["aluc"],  MAX_ROW)
            faith_range = build_formula_range(model_name, COLUMNS["faith"], MAX_ROW)
            relev_range = build_formula_range(model_name, COLUMNS["relev"], MAX_ROW)
            think_range = build_formula_range(model_name, COLUMNS["think"], MAX_ROW)
            id_range    = build_formula_range(model_name, COLUMNS["id"],    MAX_ROW)

            ranking_sheet.append([
                rank_number, model_name,
                f"=COUNTA({id_range})",
                f"=IFERROR(AVERAGE({lat_range}),\"\")",
                f"=IFERROR(PERCENTILE({lat_range},0.95),\"\")",
                f"=IFERROR(IF(AVERAGE({lat_range})>0,60/AVERAGE({lat_range}),0),\"\")",
                f"=IFERROR(AVERAGE({tok_range}),\"\")",
                f"=IFERROR(AVERAGE({socr_range}),\"\")",
                f"=IFERROR(AVERAGE({prec_range}),\"\")",
                f"=IFERROR(AVERAGE({cons_range}),\"\")",
                f"=IFERROR(AVERAGE({aluc_range}),\"\")",
                f"=IFERROR(AVERAGE({score_range}),\"\")",
                f"=IFERROR(COUNTIF({socr_range},\">=4\")/COUNTA({socr_range})*100,\"\")",
                f"=IFERROR(COUNTIF({score_range},\">=15\")/COUNTA({score_range})*100,\"\")",
                f"=IFERROR(AVERAGE({faith_range}),\"\")",
                f"=IFERROR(AVERAGE({relev_range}),\"\")",
                f"=IFERROR(COUNTIF({think_range},\"<>\")/COUNTA({id_range})*100,\"\")",
            ])
            rank_number = rank_number + 1

        article_sheet = workbook.create_sheet("Results_Article")
        article_sheet.append([
            "Model", "Arch.", "samples",
            "avg_latency (s)", "avg_tokens",
            "socraticity (0-5)", "conceptual correctness (0-5)",
            "consistency (0-5)", "hallucination rate (0-5)", "temperature",
        ])
        for model_name in ranked_models:
            lat_range   = build_formula_range(model_name, COLUMNS["lat"],   MAX_ROW)
            tok_range   = build_formula_range(model_name, COLUMNS["tok"],   MAX_ROW)
            socr_range  = build_formula_range(model_name, COLUMNS["socr"],  MAX_ROW)
            prec_range  = build_formula_range(model_name, COLUMNS["prec"],  MAX_ROW)
            cons_range  = build_formula_range(model_name, COLUMNS["cons"],  MAX_ROW)
            aluc_range  = build_formula_range(model_name, COLUMNS["aluc"],  MAX_ROW)
            id_range    = build_formula_range(model_name, COLUMNS["id"],    MAX_ROW)

            arch = architecture_map.get(model_name, "RAG")
            article_sheet.append([
                model_name, arch,
                f"=COUNTA({id_range})",
                f"=IFERROR(AVERAGE({lat_range}),\"\")",
                f"=IFERROR(AVERAGE({tok_range}),\"\")",
                f"=IFERROR(AVERAGE({socr_range}),\"\")",
                f"=IFERROR(AVERAGE({prec_range}),\"\")",
                f"=IFERROR(AVERAGE({cons_range}),\"\")",
                f"=IFERROR(AVERAGE({aluc_range}),\"\")",
                0.7,
            ])

        efficiency_sheet = workbook.create_sheet("Efficiency")
        efficiency_sheet.append(["Model", "avg_latency", "p95_latency", "throughput", "avg_tokens"])
        for model_name in ranked_models:
            lat_range = build_formula_range(model_name, COLUMNS["lat"], MAX_ROW)
            tok_range = build_formula_range(model_name, COLUMNS["tok"], MAX_ROW)
            efficiency_sheet.append([
                model_name,
                f"=IFERROR(AVERAGE({lat_range}),\"\")",
                f"=IFERROR(PERCENTILE({lat_range},0.95),\"\")",
                f"=IFERROR(IF(AVERAGE({lat_range})>0,60/AVERAGE({lat_range}),0),\"\")",
                f"=IFERROR(AVERAGE({tok_range}),\"\")",
            ])

        cot_sheet = workbook.create_sheet("CoT Analysis")
        cot_sheet.append(["Model", "faithfulness", "relevance", "pct_cot"])
        for model_name in ranked_models:
            faith_range = build_formula_range(model_name, COLUMNS["faith"], MAX_ROW)
            relev_range = build_formula_range(model_name, COLUMNS["relev"], MAX_ROW)
            think_range = build_formula_range(model_name, COLUMNS["think"], MAX_ROW)
            id_range    = build_formula_range(model_name, COLUMNS["id"],    MAX_ROW)
            cot_sheet.append([
                model_name,
                f"=IFERROR(AVERAGE({faith_range}),\"\")",
                f"=IFERROR(AVERAGE({relev_range}),\"\")",
                f"=IFERROR(COUNTIF({think_range},\"<>\")/COUNTA({id_range})*100,\"\")",
            ])

    print(f"  XLSX saved -> {file_path}")
    return file_path


def print_summary(results: List[EvalResult]) -> None:
    """
       IN -> [EvalResult] ____|_________________
                          | print_summary() | -> void
                           -----------------
       Prints the per-model summary table and the threshold-compliance
       block to the console.
    """
    models_set = set()
    for result in results:
        models_set.add(result.model)
    models = sorted(models_set)

    print(f"\n{'=' * 70}")
    print("  FINAL SUMMARY")
    print(f"  {'Model':<26} {'Score':>6} {'Socr':>5} {'Prec':>5} "
          f"{'Lat(s)':>7} {'Tput/min':>9} {'Tok':>6}")
    print(f"{'-' * 70}")

    for model_name in models:
        model_results = []
        for result in results:
            if result.model == model_name:
                model_results.append(result)

        total_score_list = []
        socratic_list = []
        precision_list = []
        latency_list = []
        token_list = []

        for result in model_results:
            total_score_list.append(result.score_total)
            socratic_list.append(result.socraticidad)
            precision_list.append(result.precision_conceptual)
            latency_list.append(result.latencia)
            token_list.append(result.tokens_generados)

        avg_score     = float(np.mean(total_score_list))
        avg_socratic  = float(np.mean(socratic_list))
        avg_precision = float(np.mean(precision_list))
        avg_latency   = float(np.mean(latency_list))
        avg_tokens    = float(np.mean(token_list))

        if avg_latency > 0:
            throughput = 60 / avg_latency
        else:
            throughput = 0

        print(f"  {model_name:<26} {avg_score:>6.2f} {avg_socratic:>5.2f} {avg_precision:>5.2f} "
              f"{avg_latency:>7.2f} {throughput:>9.1f} {avg_tokens:>6.0f}")

    print(f"{'=' * 70}")

    print("\n  THRESHOLD COMPLIANCE:")

    all_latencies = []
    for result in results:
        all_latencies.append(result.latencia)
    avg_latency = float(np.mean(all_latencies))

    if avg_latency > 0:
        overall_throughput = 60 / avg_latency
    else:
        overall_throughput = 0

    socratic_high = 0
    for result in results:
        if result.socraticidad >= 4:
            socratic_high = socratic_high + 1

    if len(results) > 0:
        pct_socratic = socratic_high / len(results) * 100
    else:
        pct_socratic = 0

    all_scores = []
    for result in results:
        all_scores.append(result.score_total)
    avg_score = float(np.mean(all_scores))

    acceptable_latency = THRESHOLDS["acceptable_latency"]
    minimum_throughput = THRESHOLDS["minimum_throughput"]
    minimum_socratic   = THRESHOLDS["minimum_socratic"]

    latency_ok    = avg_latency < acceptable_latency
    throughput_ok = overall_throughput > minimum_throughput
    socratic_ok   = (pct_socratic / 100) > minimum_socratic
    score_ok      = avg_score > 15

    if latency_ok:
        latency_mark = "OK"
    else:
        latency_mark = "!!"

    if throughput_ok:
        throughput_mark = "OK"
    else:
        throughput_mark = "!!"

    if socratic_ok:
        socratic_mark = "OK"
    else:
        socratic_mark = "!!"

    if score_ok:
        score_mark = "OK"
    else:
        score_mark = "!!"

    print(f"    [{latency_mark}] {'Avg latency':<22} {avg_latency:.2f}s       (threshold <{acceptable_latency}s)")
    print(f"    [{throughput_mark}] {'Throughput':<22} {overall_throughput:.1f}/min    (threshold >{minimum_throughput}/min)")
    print(f"    [{socratic_mark}] {'% Socratic>=4':<22} {pct_socratic:.1f}%       (threshold >{minimum_socratic * 100}%)")
    print(f"    [{score_mark}] {'Pedagogical score':<22} {avg_score:.1f}/20      (threshold >15/20)")
    print()


def main() -> None:
    """
       IN -> ____|_______
            | main() | -> void
             --------
       Entry point: parses CLI arguments, runs the benchmark and writes the
       JSON, XLSX and console summary outputs.
    """
    parser = argparse.ArgumentParser(
        description="RAG Benchmark - Socratic Tutor Ohm's Law"
    )
    parser.add_argument(
        "--models", nargs="+", default=["qwen2.5:latest"],
        help="Model label(s) for metadata (default: qwen2.5:latest)"
    )
    parser.add_argument(
        "--exercises", nargs="+", type=int, default=ALL_EXERCISES, metavar="N",
        help=f"Exercises to evaluate (default: all {ALL_EXERCISES}). Example: --exercises 3 5 7"
    )
    parser.add_argument(
        "--max-per-exercise", type=int, default=None, metavar="N",
        help="Maximum cases per exercise (default: all)"
    )
    parser.add_argument(
        "--data-dir", default=str(DATA_DIR),
        help="Backend data directory"
    )
    parser.add_argument(
        "--output-dir", default=str(OUTPUT_DIR),
        help="Output directory for JSON and XLSX"
    )
    parser.add_argument(
        "--turns", type=int, default=3, metavar="N",
        help="Turns per conversation (default: 3)"
    )
    parser.add_argument(
        "--backend-url", default=BACKEND_URL,
        help=f"Backend URL running the full RAG pipeline (default: {BACKEND_URL})"
    )
    parser.add_argument(
        "--exercise-map", default=None, metavar="JSON",
        help='Manual exercise mapping as JSON, e.g. \'{"1": "abc123", "3": "def456"}\''
    )
    args = parser.parse_args()

    data_dir   = Path(args.data_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    exercise_map_dict: Optional[Dict[str, str]] = None
    if args.exercise_map:
        exercise_map_dict = json.loads(args.exercise_map)

    print("=" * 70)
    print("  RAG BENCHMARK - Socratic Tutor Ohm's Law")
    print("=" * 70)
    print(f"  Models      : {args.models}")
    print(f"  Exercises   : {args.exercises}")
    print(f"  Backend URL : {args.backend_url}")
    print(f"  Data dir    : {data_dir}")
    print(f"  Output dir  : {output_dir}")
    print(f"  Max/exercise: {args.max_per_exercise or 'all'}")
    print(f"  Turns/conv  : {args.turns}")

    benchmark = RagBenchmark(data_dir, backend_url=args.backend_url)
    results   = benchmark.run(
        models=args.models,
        exercises=args.exercises,
        max_per_exercise=args.max_per_exercise,
        turns=args.turns,
        exercise_map=exercise_map_dict,
    )

    if not results:
        print("\n[ERROR] No results obtained. Check connectivity.")
        sys.exit(1)

    timestamp_str = str(int(time.time()))
    print(f"\n{'=' * 70}")
    print(f"  Saving {len(results)} results (timestamp={timestamp_str})...")
    save_json(results, output_dir, timestamp_str)
    save_xlsx(results, output_dir, timestamp_str)

    print_summary(results)


if __name__ == "__main__":
    main()
