#!/usr/bin/env python3
"""
build data.js (const parts / const sets) from kaggle lego database csvs (rtatman/lego-database).
default data dir: ./lego-data or $LEGO_DATA_DIR; else ~/.cache/kagglehub/.../versions/1
"""
from __future__ import annotations
import argparse
import json
import os
import sys
from pathlib import Path
import pandas as pd

DEFAULT_KAGGLEHUB = Path.home() / ".cache/kagglehub/datasets/rtatman/lego-database/versions/1"
def find_data_dir(cli: str | None) -> Path:
    if cli:
        return Path(cli).expanduser().resolve()
    env = os.environ.get("LEGO_DATA_DIR")
    if env:
        return Path(env).expanduser().resolve()
    local = Path("lego-data")
    if local.is_dir() and (local / "sets.csv").exists():
        return local.resolve()
    if DEFAULT_KAGGLEHUB.is_dir() and (DEFAULT_KAGGLEHUB / "sets.csv").exists():
        return DEFAULT_KAGGLEHUB
    raise SystemExit(
        "Could not find LEGO CSVs. Place Kaggle extract in ./lego-data/ or set LEGO_DATA_DIR, "
        "or run: pip install kagglehub && python -c \"import kagglehub; kagglehub.dataset_download('rtatman/lego-database')\""
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", type=str, default=None, help="Folder containing sets.csv, etc.")
    ap.add_argument(
        "--max-sets",
        type=int,
        default=0,
        help="Cap sets after theme spread; 0 = no cap (largest output; use e.g. 800 for a smaller Pages-friendly file).",
    )
    ap.add_argument(
        "--per-theme",
        type=int,
        default=0,
        help="Max sets per theme when spreading; 0 = every set in each theme (before --max-sets).",
    )
    ap.add_argument(
        "--top-parts",
        type=int,
        default=0,
        help="Top N parts by distinct set count; 0 = keep every part row in merged inventory (richest BOMs, largest file).",
    )
    ap.add_argument("-o", "--output", type=str, default="data.js")
    args = ap.parse_args()

    if args.max_sets <= 0 or args.per_theme <= 0 or args.top_parts <= 0:
        print(
            "build_data: at least one of --max-sets / --per-theme / --top-parts is 0 (unbounded). "
            "Expect long runtime and a large data.js — pass positive caps if GitHub Pages or RAM struggles.",
            file=sys.stderr,
        )

    d = find_data_dir(args.data_dir)
    sets_df = pd.read_csv(d / "sets.csv")
    sets_df["set_num"] = sets_df["set_num"].astype(str)
    themes_df = pd.read_csv(d / "themes.csv")
    inv_df = pd.read_csv(d / "inventories.csv")
    inv_parts_df = pd.read_csv(d / "inventory_parts.csv")
    parts_df = pd.read_csv(d / "parts.csv")
    parts_df["part_num"] = parts_df["part_num"].astype(str)
    cats_df = pd.read_csv(d / "part_categories.csv")

    theme_map = themes_df.set_index("id")["name"].to_dict()
    sets_df = sets_df.copy()
    sets_df["theme"] = sets_df["theme_id"].map(theme_map).fillna("Unknown")

    inv_df = inv_df.copy()
    inv_df["set_num"] = inv_df["set_num"].astype(str)
    inv_v1 = inv_df[inv_df["version"] == 1][["id", "set_num"]].rename(columns={"id": "inventory_id"})

    inv_parts_df = inv_parts_df.copy()
    inv_parts_df["part_num"] = inv_parts_df["part_num"].astype(str)
    merged = inv_v1.merge(inv_parts_df, on="inventory_id", how="inner")
    if "is_spare" in merged.columns:
        merged = merged[merged["is_spare"].astype(str).str.lower().isin(["false", "0", "f"])]

    merged = merged.merge(
        parts_df[["part_num", "name", "part_cat_id"]],
        on="part_num",
        how="inner",
    )
    cats_renamed = cats_df.rename(columns={"id": "part_cat_id", "name": "category"})
    merged = merged.merge(cats_renamed, on="part_cat_id", how="left")
    merged["category"] = merged["category"].fillna("Other")
    merged["set_num"] = merged["set_num"].astype(str)

    if args.top_parts <= 0:
        top_set = set(merged["part_num"].astype(str).unique())
    else:
        top_parts = (
            merged.groupby("part_num")["set_num"]
            .nunique()
            .nlargest(args.top_parts)
            .index.tolist()
        )
        top_set = set(str(p) for p in top_parts)

    merged_top = merged[merged["part_num"].isin(top_set)]
    set_parts = (
        merged_top.groupby("set_num")["part_num"]
        .apply(lambda x: sorted(x.unique().tolist()))
        .to_dict()
    )
    set_parts = {str(k): v for k, v in set_parts.items()}

    sets_df = sets_df[sets_df["set_num"].isin(set_parts.keys())]
    sets_df = sets_df[sets_df["set_num"].map(lambda s: len(set_parts.get(s, []))) > 0]

    # stratify by theme: prefer larger sets, spread themes
    picked = []
    for theme in sorted(sets_df["theme"].unique(), key=str):
        sub = sets_df[sets_df["theme"] == theme].copy()
        sub["_n"] = sub["set_num"].map(lambda s: len(set_parts.get(str(s), [])))
        sub = sub[sub["_n"] >= 1].sort_values(["num_parts", "year"], ascending=[False, False])
        if len(sub) > 0:
            if args.per_theme <= 0:
                picked.append(sub)
            else:
                picked.append(sub.head(args.per_theme))

    if not picked:
        sub = sets_df.copy()
        sub["_n"] = sub["set_num"].map(lambda s: len(set_parts.get(str(s), [])))
        sub = sub[sub["_n"] >= 1].sort_values(["num_parts", "year"], ascending=[False, False])
        cap = sub if args.max_sets <= 0 else sub.head(args.max_sets)
    else:
        cap = pd.concat(picked, ignore_index=True).drop_duplicates(subset=["set_num"])
        if args.max_sets > 0:
            cap = cap.head(args.max_sets)

    allowed_sets = set(cap["set_num"].astype(str))
    # trim part lists to only sets we're shipping
    set_parts_f = {s: set_parts[s] for s in allowed_sets if s in set_parts}

    used_part_nums: set[str] = set()
    for lst in set_parts_f.values():
        used_part_nums.update(lst)

    parts_meta = parts_df[parts_df["part_num"].astype(str).isin(used_part_nums)].merge(
        cats_renamed, on="part_cat_id", how="left"
    )
    parts_out = []
    for _, row in parts_meta.iterrows():
        parts_out.append(
            {
                "id": str(row["part_num"]),
                "name": str(row["name"]),
                "category": str(row["category"]) if pd.notna(row.get("category")) else "Other",
            }
        )
    parts_out.sort(key=lambda p: (p["category"], p["name"]))

    sets_out = []
    for _, row in cap.iterrows():
        sid = str(row["set_num"])
        plist = set_parts_f.get(sid, [])
        year = int(row["year"]) if pd.notna(row["year"]) else 2000
        try:
            nparts = int(row["num_parts"])
        except (TypeError, ValueError):
            nparts = len(plist)
        sets_out.append(
            {
                "id": sid,
                "name": str(row["name"]),
                "year": year,
                "theme": str(row["theme"]),
                "num_parts": nparts,
                # primary: rebrickable cdn (works on static hosts without images/sets/*).
                # ui.js also tries brickset, images/sets/{id}.*, set_num variants (e.g. 4428-12 --> 4428-1).
                "image": f"https://cdn.rebrickable.com/media/sets/{sid}.jpg",
                "image_alt": f"https://images.brickset.com/sets/images/{sid}.jpg",
                "parts": plist,
            }
        )
    out_path = Path(args.output).resolve()
    header = (
        "// data.js — generated by scripts/build_data.py\n"
        "// kaggle dataset: https://www.kaggle.com/datasets/rtatman/lego-database\n"
        f"// sets: {len(sets_out)}, parts catalog entries: {len(parts_out)}\n\n"
    )
    _json_opts = {"ensure_ascii": False, "separators": (",", ":")}

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(header)
        f.write("const parts = ")
        f.write(json.dumps(parts_out, **_json_opts))
        f.write(";\n\nconst sets = ")
        f.write(json.dumps(sets_out, **_json_opts))
        f.write(";\n")
    print(f"Wrote {out_path} ({len(sets_out)} sets, {len(parts_out)} parts)")
if __name__ == "__main__":
    main()
