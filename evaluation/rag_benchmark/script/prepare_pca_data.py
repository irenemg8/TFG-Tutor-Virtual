#!/usr/bin/env python3
"""
prepare_pca_data.py
===================
Combina los datos del profesor (qwen2.5 base/finetuned/tfidf) con los
resultados del benchmark RAG (qwen2.5/rag) y genera:

  - Datos_spider_qwen25_combined.xlsx   →  formato Datos_spider para el PCA
  - data2_qwen25.xlsx                   →  latencia y tokens para el bubble plot

Uso:
    python prepare_pca_data.py
    python prepare_pca_data.py --rag-json results/rag_benchmark_1234567890.json

Los archivos de salida se guardan en:
    C:/Users/irene/Downloads/data/
"""

import json
import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# ── Rutas ─────────────────────────────────────────────────────────────────────
_SCRIPT_DIR   = Path(__file__).parent
RESULTS_DIR   = (_SCRIPT_DIR / "../results").resolve()
OUTPUT_DIR    = Path(r"C:/Users/irene/Downloads/data")
PROFESSOR_DIR = Path(r"C:/Users/irene/Downloads/Congreso_TAEE26/Congreso_TAEE26/Irene/Resultados Qwen2.5")

PROF_FILES = {
    "base":      PROFESSOR_DIR / "eval_base_20251205_081200.xlsx",
    "finetuned": PROFESSOR_DIR / "eval_finetuned_20251205_081200.xlsx",
    "tfidf":     PROFESSOR_DIR / "eval_fewshot_20251205_081200.xlsx",
}

# ── Helpers ────────────────────────────────────────────────────────────────────

def latest_rag_json() -> Path:
    """Devuelve el JSON de benchmark más reciente en results/."""
    jsons = sorted(RESULTS_DIR.glob("rag_benchmark_*.json"))
    if not jsons:
        raise FileNotFoundError(f"No hay JSONs en {RESULTS_DIR}")
    return jsons[-1]


def load_professor_arch(arch: str, path: Path) -> pd.DataFrame:
    """
    Lee un Excel del profesor y devuelve un DataFrame con columnas normalizadas:
      Unnamed: 0 (model), Modelo (arch), Temp,
      Socraticity (1-5), Conceptual (1-5), Hallutination (1-5)

    Mapeo:
      formato_socratico     → Socraticity (1-5)
      correccion_conceptual → Conceptual (1-5)
      generacion_reflexion  → se invierte (5 - val) para usarla como Hallutination
                              (el notebook la volverá a invertir, recuperando el valor original)
    """
    df = pd.read_excel(path)
    out = pd.DataFrame()
    out["Socraticity (1-5)"]    = df["formato_socratico"].astype(float)
    out["Conceptual (1-5)"]     = df["correccion_conceptual"].astype(float)
    # generacion_reflexion es 1-5 donde mayor=mejor; invertimos para que la
    # columna Hallutination siga la misma escala que en Datos_spider.xlsx
    # (menor = peor, y el notebook la invierte con 5-x)
    out["Hallutination (1-5)"]  = (5 - df["generacion_reflexion"]).astype(float)
    # escalares después de las Series para que pandas tenga índice
    out["Unnamed: 0"]           = "qwen2.5:latest"
    out["Modelo"]               = arch
    out["Temp"]                 = 0.7
    return out[["Unnamed: 0", "Modelo", "Temp",
                "Socraticity (1-5)", "Conceptual (1-5)", "Hallutination (1-5)"]]


def load_rag_xlsx(xlsx_path: Path):
    """
    Lee el XLSX del benchmark RAG (hoja Results_qwen2.5_latest) y devuelve
    un DataFrame normalizado para PCA + df_raw compatible con build_data2.

    Mapeo:
      Socratic Quality   → Socraticity (1-5)
      Conceptual Precision → Conceptual (1-5)
      Hallucination Rate → se invierte (5 - val) para Hallutination
    """
    df_raw = pd.read_excel(xlsx_path, sheet_name="Results_qwen2.5_latest")
    # Renombrar para compatibilidad con build_data2
    df_raw = df_raw.rename(columns={
        "Latency (s)":  "latencia",
        "Tokens":       "tokens_generados",
    })

    out = pd.DataFrame()
    out["Socraticity (1-5)"]   = df_raw["Socratic Quality"].astype(float)
    out["Conceptual (1-5)"]    = df_raw["Conceptual Precision"].astype(float)
    # Hallucination Rate: 5=sin alucinaciones=mejor → invertimos igual que en JSON
    out["Hallutination (1-5)"] = (5 - df_raw["Hallucination Rate"]).astype(float)
    out["Unnamed: 0"]          = "qwen2.5:latest"
    out["Modelo"]              = "rag"
    out["Temp"]                = 0.7
    return out[["Unnamed: 0", "Modelo", "Temp",
                "Socraticity (1-5)", "Conceptual (1-5)", "Hallutination (1-5)"]], df_raw


def load_rag_json(json_path: Path) -> pd.DataFrame:
    """
    Lee el JSON del benchmark RAG y devuelve un DataFrame normalizado.

    Mapeo:
      socraticidad       → Socraticity (1-5)
      precision_conceptual → Conceptual (1-5)
      tasa_alucinacion   → se invierte (5 - val) para Hallutination
                           (tasa_alucinacion: 5=sin alucinaciones=mejor)
    """
    with open(json_path, encoding="utf-8") as f:
        payload = json.load(f)

    results = payload.get("results", [])
    if not results:
        raise ValueError(f"El JSON {json_path} no contiene resultados")

    # Filtrar solo qwen2.5
    rows = [r for r in results if "qwen2.5" in r.get("model", "").lower()]
    if not rows:
        raise ValueError("No hay filas de qwen2.5 en el JSON")

    df_raw = pd.DataFrame(rows)
    out = pd.DataFrame()
    out["Socraticity (1-5)"]    = df_raw["socraticidad"].astype(float)
    out["Conceptual (1-5)"]     = df_raw["precision_conceptual"].astype(float)
    # tasa_alucinacion: 5=sin alucinaciones=mejor → invertimos para Hallutination
    out["Hallutination (1-5)"]  = (5 - df_raw["tasa_alucinacion"]).astype(float)
    # escalares después de las Series para que pandas tenga índice
    out["Unnamed: 0"]           = "qwen2.5:latest"
    out["Modelo"]               = "rag"
    out["Temp"]                 = 0.7
    return out[["Unnamed: 0", "Modelo", "Temp",
                "Socraticity (1-5)", "Conceptual (1-5)", "Hallutination (1-5)"]], df_raw


def build_data2(prof_dfs: dict, rag_raw: pd.DataFrame) -> pd.DataFrame:
    """
    Construye data2_qwen25.xlsx con latencia media y tokens medios por arquitectura.
    """
    rows = []

    # Arquitecturas del profesor
    arch_labels = {"base": "Base", "finetuned": "FT", "tfidf": "TF-IDF"}
    for arch, path in PROF_FILES.items():
        df = pd.read_excel(path)
        rows.append({
            "Model":          "Qwen2.5",
            "Arch":           arch_labels[arch],
            "Latency (mean)": round(df["latencia"].mean(), 3),
            "Tokens (mean)":  round(df["tokens_generados"].mean(), 1),
        })

    # RAG
    rows.append({
        "Model":          "Qwen2.5",
        "Arch":           "RAG",
        "Latency (mean)": round(rag_raw["latencia"].mean(), 3),
        "Tokens (mean)":  round(rag_raw["tokens_generados"].mean(), 1),
    })

    return pd.DataFrame(rows)


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Prepara datos PCA para qwen2.5")
    parser.add_argument(
        "--rag-json", default=None,
        help="Ruta al JSON del benchmark RAG (por defecto: el más reciente en results/)"
    )
    parser.add_argument(
        "--rag-xlsx", default=None,
        help="Ruta al XLSX del benchmark RAG (alternativa al JSON)"
    )
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # ── Datos del profesor ───────────────────────────────────────────────────
    print("Leyendo datos del profesor (qwen2.5 base/finetuned/tfidf)...")
    prof_parts = []
    for arch, path in PROF_FILES.items():
        if not path.exists():
            print(f"  [ERROR] No encontrado: {path}")
            sys.exit(1)
        part = load_professor_arch(arch, path)
        print(f"  {arch}: {len(part)} filas  "
              f"Soc={part['Socraticity (1-5)'].mean():.2f}  "
              f"Conc={part['Conceptual (1-5)'].mean():.2f}")
        prof_parts.append(part)

    # ── Datos RAG ────────────────────────────────────────────────────────────
    if args.rag_xlsx:
        rag_path = Path(args.rag_xlsx)
        print(f"\nLeyendo resultados RAG desde XLSX: {rag_path.name}")
        rag_df, rag_raw = load_rag_xlsx(rag_path)
    else:
        rag_path = Path(args.rag_json) if args.rag_json else latest_rag_json()
        print(f"\nLeyendo resultados RAG desde JSON: {rag_path.name}")
        rag_df, rag_raw = load_rag_json(rag_path)
    print(f"  rag: {len(rag_df)} filas  "
          f"Soc={rag_df['Socraticity (1-5)'].mean():.2f}  "
          f"Conc={rag_df['Conceptual (1-5)'].mean():.2f}")

    # ── Combinar ─────────────────────────────────────────────────────────────
    combined = pd.concat(prof_parts + [rag_df], ignore_index=True)
    combined["Temp"] = combined["Temp"].astype(str)

    spider_path = OUTPUT_DIR / "Datos_spider_qwen25_combined.xlsx"
    combined.to_excel(spider_path, index=False)
    print(f"\nGuardado: {spider_path}  ({len(combined)} filas)")
    print(combined.groupby("Modelo")[["Socraticity (1-5)", "Conceptual (1-5)", "Hallutination (1-5)"]].mean().round(2))

    # ── data2 ────────────────────────────────────────────────────────────────
    data2 = build_data2(PROF_FILES, rag_raw)
    data2_path = OUTPUT_DIR / "data2_qwen25.xlsx"
    data2.to_excel(data2_path, index=False)
    print(f"\nGuardado: {data2_path}")
    print(data2.to_string(index=False))

    print("\nListo. Abre pca 1.ipynb y ejecuta todas las celdas.")


if __name__ == "__main__":
    main()
