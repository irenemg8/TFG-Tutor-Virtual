#!/usr/bin/env python3
"""
------------------------------------------------------------------------------
            _________________________________________________________
            |                     PREPARE PCA DATA                  |
            |  Merges the professor's qwen2.5 results (base /        |
            |  finetuned / tfidf) with the RAG benchmark results and |
            |  emits the spider-format and bubble-plot spreadsheets  |
            |  consumed by the PCA notebook.                         |
        ____|________________                                        |
   void -> | latest_rag_json() | -> Path                             |
           ---------------------                                     |
        ____|___________________________                             |
        | load_professor_arch() | -> DataFrame                       |
        -------------------------                                    |
        ____|_____________________                                   |
        | load_rag_xlsx() | -> (DataFrame, DataFrame)                |
        -------------------                                          |
        ____|_____________________                                   |
        | load_rag_json() | -> (DataFrame, DataFrame)                |
        -------------------                                          |
        ____|__________________                                      |
        | build_data2() | -> DataFrame                               |
        ----------------                                             |
        ____|___________                                             |
        | main() | -> void                                           |
        ----------                                                   |
            |                                                        |
            |________________________________________________________|
------------------------------------------------------------------------------
"""

import json
import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

_SCRIPT_DIR   = Path(__file__).parent
RESULTS_DIR   = (_SCRIPT_DIR / "../results").resolve()
OUTPUT_DIR    = Path(r"C:/Users/irene/Downloads/data")
PROFESSOR_DIR = Path(r"C:/Users/irene/Downloads/Congreso_TAEE26/Congreso_TAEE26/Irene/Resultados Qwen2.5")

PROF_FILES = {
    "base":      PROFESSOR_DIR / "eval_base_20251205_081200.xlsx",
    "finetuned": PROFESSOR_DIR / "eval_finetuned_20251205_081200.xlsx",
    "tfidf":     PROFESSOR_DIR / "eval_fewshot_20251205_081200.xlsx",
}


def latest_rag_json() -> Path:
    """
       IN -> ____|________________
            | latest_rag_json() | -> Path
             -------------------
       Returns the most recent rag_benchmark_*.json file in the results
       directory. Raises FileNotFoundError when none exist.
    """
    jsons = sorted(RESULTS_DIR.glob("rag_benchmark_*.json"))
    if not jsons:
        raise FileNotFoundError(f"No hay JSONs en {RESULTS_DIR}")
    return jsons[-1]


def load_professor_arch(arch: str, path: Path) -> pd.DataFrame:
    """
       IN -> Txt, Path ____|________________________
                       | load_professor_arch() | -> DataFrame
                        -------------------------
       Reads one professor Excel file and returns a normalized DataFrame
       with the spider columns; the reflection score is inverted (5 - val)
       so it follows the same hallucination scale as Datos_spider.xlsx.
    """
    df = pd.read_excel(path)
    out = pd.DataFrame()
    out["Socraticity (1-5)"]    = df["formato_socratico"].astype(float)
    out["Conceptual (1-5)"]     = df["correccion_conceptual"].astype(float)
    out["Hallutination (1-5)"]  = (5 - df["generacion_reflexion"]).astype(float)
    out["Unnamed: 0"]           = "qwen2.5:latest"
    out["Modelo"]               = arch
    out["Temp"]                 = 0.7
    return out[["Unnamed: 0", "Modelo", "Temp",
                "Socraticity (1-5)", "Conceptual (1-5)", "Hallutination (1-5)"]]


def load_rag_xlsx(xlsx_path: Path):
    """
       IN -> Path ____|__________________
                  | load_rag_xlsx() | -> (DataFrame, DataFrame)
                   -------------------
       Reads the RAG benchmark XLSX (Results_qwen2.5_latest sheet) and
       returns a PCA-normalized DataFrame plus the raw DataFrame used by
       build_data2; the hallucination rate is inverted (5 - val).
    """
    df_raw = pd.read_excel(xlsx_path, sheet_name="Results_qwen2.5_latest")
    df_raw = df_raw.rename(columns={
        "Latency (s)":  "latencia",
        "Tokens":       "tokens_generados",
    })

    out = pd.DataFrame()
    out["Socraticity (1-5)"]   = df_raw["Socratic Quality"].astype(float)
    out["Conceptual (1-5)"]    = df_raw["Conceptual Precision"].astype(float)
    out["Hallutination (1-5)"] = (5 - df_raw["Hallucination Rate"]).astype(float)
    out["Unnamed: 0"]          = "qwen2.5:latest"
    out["Modelo"]              = "rag"
    out["Temp"]                = 0.7
    return out[["Unnamed: 0", "Modelo", "Temp",
                "Socraticity (1-5)", "Conceptual (1-5)", "Hallutination (1-5)"]], df_raw


def load_rag_json(json_path: Path) -> pd.DataFrame:
    """
       IN -> Path ____|__________________
                  | load_rag_json() | -> (DataFrame, DataFrame)
                   -------------------
       Reads the RAG benchmark JSON, keeps only qwen2.5 rows and returns a
       PCA-normalized DataFrame plus the raw DataFrame; the hallucination
       rate is inverted (5 - val) so higher means worse.
    """
    with open(json_path, encoding="utf-8") as f:
        payload = json.load(f)

    results = payload.get("results", [])
    if not results:
        raise ValueError(f"El JSON {json_path} no contiene resultados")

    rows = [r for r in results if "qwen2.5" in r.get("model", "").lower()]
    if not rows:
        raise ValueError("No hay filas de qwen2.5 en el JSON")

    df_raw = pd.DataFrame(rows)
    out = pd.DataFrame()
    out["Socraticity (1-5)"]    = df_raw["socraticidad"].astype(float)
    out["Conceptual (1-5)"]     = df_raw["precision_conceptual"].astype(float)
    out["Hallutination (1-5)"]  = (5 - df_raw["tasa_alucinacion"]).astype(float)
    out["Unnamed: 0"]           = "qwen2.5:latest"
    out["Modelo"]               = "rag"
    out["Temp"]                 = 0.7
    return out[["Unnamed: 0", "Modelo", "Temp",
                "Socraticity (1-5)", "Conceptual (1-5)", "Hallutination (1-5)"]], df_raw


def build_data2(prof_dfs: dict, rag_raw: pd.DataFrame) -> pd.DataFrame:
    """
       IN -> dict, DataFrame ____|_______________
                             | build_data2() | -> DataFrame
                              ----------------
       Builds data2_qwen25.xlsx with mean latency and mean tokens per
       architecture (professor archs + RAG) for the bubble plot.
    """
    rows = []

    arch_labels = {"base": "Base", "finetuned": "FT", "tfidf": "TF-IDF"}
    for arch, path in PROF_FILES.items():
        df = pd.read_excel(path)
        rows.append({
            "Model":          "Qwen2.5",
            "Arch":           arch_labels[arch],
            "Latency (mean)": round(df["latencia"].mean(), 3),
            "Tokens (mean)":  round(df["tokens_generados"].mean(), 1),
        })

    rows.append({
        "Model":          "Qwen2.5",
        "Arch":           "RAG",
        "Latency (mean)": round(rag_raw["latencia"].mean(), 3),
        "Tokens (mean)":  round(rag_raw["tokens_generados"].mean(), 1),
    })

    return pd.DataFrame(rows)


def main():
    """
       IN -> ____|_______
            | main() | -> void
             --------
       Entry point: reads professor and RAG data, merges them and writes
       the spider-format and bubble-plot spreadsheets to the output dir.
    """
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

    combined = pd.concat(prof_parts + [rag_df], ignore_index=True)
    combined["Temp"] = combined["Temp"].astype(str)

    spider_path = OUTPUT_DIR / "Datos_spider_qwen25_combined.xlsx"
    combined.to_excel(spider_path, index=False)
    print(f"\nGuardado: {spider_path}  ({len(combined)} filas)")
    print(combined.groupby("Modelo")[["Socraticity (1-5)", "Conceptual (1-5)", "Hallutination (1-5)"]].mean().round(2))

    data2 = build_data2(PROF_FILES, rag_raw)
    data2_path = OUTPUT_DIR / "data2_qwen25.xlsx"
    data2.to_excel(data2_path, index=False)
    print(f"\nGuardado: {data2_path}")
    print(data2.to_string(index=False))

    print("\nListo. Abre pca 1.ipynb y ejecuta todas las celdas.")


if __name__ == "__main__":
    main()
