# Language Detection & Multi-Language Tutoring

The virtual tutor speaks **three languages**: Spanish (`es`, default), Valencian (`val`) and English (`en`). It must answer in the language the student is using, switch when the student explicitly asks, and keep its circuit terminology correct in each language.

All of this lives in one module: **`backend/src/domain/services/languageManager.js`**. This document explains how the language for a turn is decided, how it is enforced, and what else is language-aware.

> The chat model is referred to as **qwen2.5**.

---

## Table of Contents

1. [The Problem](#the-problem)
2. [Supported Languages](#supported-languages)
3. [How the Language Is Resolved](#how-the-language-is-resolved)
4. [Explicit Switch Detection](#explicit-switch-detection)
5. [Heuristic Detection](#heuristic-detection)
6. [How the Choice Is Enforced](#how-the-choice-is-enforced)
7. [Everything That Is Language-Aware](#everything-that-is-language-aware)
8. [Retrieval Normalization](#retrieval-normalization)
9. [Design Decisions](#design-decisions)
10. [Legacy Approach (historical)](#legacy-approach-historical)

---

## The Problem

The system prompt carries a large amount of Spanish context (exercise statement, expert reasoning, netlist, examples, knowledge-graph entries). If the prompt only said "respond in the same language as the student", the LLM would anchor to the dominant Spanish context and keep answering in Spanish — an effect known as **linguistic inertia**. A short message like "Hello" can't overcome thousands of Spanish tokens.

The fix is to **decide the language server-side** and tell the model *explicitly* which language to use this turn, in language-specific rules placed in the system prompt — never a generic "same language" instruction.

---

## Supported Languages

```javascript
const SUPPORTED_LANGS = ["es", "val", "en"];
const DEFAULT_LANG = "es";
```

The domain deliberately supports the three languages relevant to the UPV context (Spanish, Valencian, English), each with curated terminology and grammar rules — not a generic 60-language detector. Anything outside these three falls back to Spanish.

---

## How the Language Is Resolved

**Function:** `resolveLanguage(conversationHistory)`

Called by the `ContextAgent` (and the legacy middleware) at the start of every turn. It walks the conversation **newest-first** and applies two stages:

```
resolveLanguage(history)
   │
   ├─ 1. Newest-first, for each USER message:
   │       detectLanguageSwitch(content)  → if an explicit "switch to X" is found, RETURN X
   │
   ├─ 2. Otherwise, on the LAST user message only:
   │       detectLanguageHeuristic(content) → if confident, RETURN it
   │
   └─ 3. Fallback → "es"
```

An explicit switch request **anywhere** in the history wins (and the most recent one wins), so once a student asks to continue in English the tutor stays in English. If no one ever asked to switch, the heuristic classifies the latest user message; if even that is inconclusive, Spanish is used.

---

## Explicit Switch Detection

**Function:** `detectLanguageSwitch(message)` → `"es" | "val" | "en" | null`

Scans the (lower-cased) message for curated switch phrases per language, e.g.:

| Target | Example phrases |
|---|---|
| `es` | "habla en español", "en castellano", "continúa en español", "responde en español" |
| `val` | "parla en valencià", "respon en valencià", "podem continuar en valencià" |
| `en` | "speak in english", "switch to english", "can we continue in english", "in english please" |

**Negation guard.** Before accepting a match, `_hasNegativeContext()` checks the ~40 characters immediately before it for negative prefixes ("no", "no entiendo", "don't", "no ho entenc", …). This prevents "**no** entiendo el inglés" from being read as a request to switch to English.

---

## Heuristic Detection

**Function:** `detectLanguageHeuristic(message)` → `"es" | "val" | "en" | null`

Used when there is no explicit switch request. It is a lightweight stopword classifier:

1. Tokenize the message (lower-case, strip punctuation, split on whitespace). If fewer than 3 tokens → `null` (too short to classify).
2. Count how many tokens appear in each language's **stopword list** (`HEURISTIC_STOPWORDS` — common function words like `el/la/que/porque`, `el/els/què/perquè`, `the/that/because`).
3. Pick the language with the most hits, but only if it is **confident**:
   - the top count is **≥ 2**, and
   - the top count is **≥ 1.5×** the second-place count.
4. Otherwise → `null` (defer to the Spanish fallback).

This favours precision over recall: a one-word reply ("Vale", "Sí") returns `null` and keeps the previously established language rather than guessing.

---

## How the Choice Is Enforced

Once `lang` is resolved it is threaded through the whole turn. The decisive enforcement point is the **language rules block** in the system prompt:

**Function:** `getLanguageRules(lang)` — returns a per-language rules block included by `promptBuilder.buildTutorSystemPrompt(ejercicio, lang)`.

Each block:
- names the language explicitly ("Responde en español en este turno" / "Respon en valencià" / "Reply in English in this turn"),
- instructs the model to **switch immediately** if the student asks, and never refuse a switch,
- pins the **correct technical terminology** (e.g. Spanish "tierra"/"nudo"/"condensador", Valencian "terra"/"nus"/"font de tensió", English "ground"/"node"/"capacitor"),
- for Valencian, adds explicit grammar rules (verb conjugations, accents, articles, contractions) because the model is most error-prone there.

Because the instruction names a concrete language and lives in the system prompt (and the chosen language also governs the conversation history and every augmentation block), the model has no competing signal pulling it back to Spanish.

---

## Everything That Is Language-Aware

`languageManager.js` is the single source of truth for all language-dependent strings and patterns, selected by `lang`:

| Category | Function / dictionary | Used by |
|---|---|---|
| System-prompt rules | `getLanguageRules` | prompt builder |
| Finish messages | `getFinishMessages` | deterministic finish |
| Greeting responses | `getGreetingResponse` | greeting fast-path |
| Classifier patterns | `greetingPatterns`, `dontKnowPatterns`, `reasoningPatterns`, `conceptKeywords`, `frustrationPatterns` | query classifier, loop detection |
| Guardrail detection patterns | `revealPhrases`, `confirmPhrases`, `stateRevealPatterns` | guardrails |
| Guardrail retry hints | `getStrongerInstruction`, `getFalseConfirmationInstruction`, `getPartialConfirmationInstruction`, `getCompleteSolutionInstruction`, `getStateRevealInstruction`, `getElementNamingInstruction`, `getLanguageDriftRetryHint`, `getRepeatedQuestionRetryHint` | guardrail pipeline |
| Intermediate feedback phrases | `getIntermediateFeedback`, `getRandomIntermediatePhrase`, `startsWithIntermediatePhrase` | RAG augmentation, pedagogical reviewer |
| Didactic fallback questions | `getDidacticFallbackQuestions`, `getDidacticFallbackPrefix` | pedagogical reviewer |
| Pattern flattening | `getAllPatterns(dict)` | classifier (cross-language matching) |

This is why adding or correcting a language touches one module rather than the classifier, guardrails and prompt builder separately.

---

## Retrieval Normalization

**Function:** `normalizeToSpanish(query)`

The retrieval datasets are written in Spanish. When the student writes in Valencian or English, `normalizeToSpanish()` maps domain terms (via the `termToSpanish` table) to their Spanish equivalents before hybrid search / CRAG, so a Valencian or English message still matches the Spanish examples. The student-facing *response* stays in the resolved language; only the retrieval query is normalized.

---

## Design Decisions

**Why three curated languages instead of a generic detector?** The tutor needs *correct circuit terminology and grammar* per language, not just a language code. Curating es/val/en lets the rules block pin the right vocabulary and fix the model's known Valencian grammar mistakes — value a generic 60-language detector cannot provide.

**Why explicit switch detection separate from the heuristic?** A direct request ("can we continue in English") must always be honoured immediately and must override the statistical signal of a still-mostly-Spanish history. Keeping it a separate, history-wide check guarantees that.

**Why a confidence threshold on the heuristic?** Short replies have little signal. Requiring ≥2 hits and a 1.5× lead avoids flip-flopping the language on "Vale" or "OK" and keeps the conversation stable.

**Why default to Spanish?** It is the primary language of the course and of the exercise content, so it is the safest fallback when the signal is weak.

---

## Legacy Approach (historical)

The pre-refactor implementation (`backend/src/utils/promptBuilder.js`, still present for reference) used the `tinyld` library to detect ~60 languages, a hand-curated `SHORT_LANG_MAP` of common short phrases to patch `tinyld`'s weakness on short inputs, and a two-point injection of a generic `[LANGUAGE INSTRUCTION]` string. That approach has been **superseded** by the curated three-language `languageManager` described above. `tinyld` remains a dependency only because of this legacy file; the active domain code does not use it.
