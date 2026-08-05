#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate/render edu-chem-reaction specs for AI pipeline (M1/M2)."""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path
from typing import Any


def _find_skill_dir() -> Path:
    env = Path(__file__).resolve()
    root = env.parents[4]  # server/services/ai/python -> repo root
    candidates = [
        root / "node_modules" / "@wy51ai" / "edulab" / "skills" / "edu-chem-reaction",
        root / "skills" / "edu-chem-reaction",
    ]
    for c in candidates:
        if (c / "lib" / "reaction_kernel.py").exists():
            return c
    raise FileNotFoundError("edu-chem-reaction skill not found under node_modules or skills/")


def _load_kernel(skill_dir: Path):
    sys.path.insert(0, str(skill_dir / "lib"))
    import reaction_kernel as K  # noqa: WPS433
    import molecules as M  # noqa: WPS433
    return K, M


def _read_spec(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "payload" in data and isinstance(data["payload"], dict):
        return data["payload"]
    return data


def _load_extensions(path: Path | None) -> list[dict[str, Any]]:
    if not path:
        return []
    p = Path(path)
    if not p.exists():
        return []
    data = json.loads(p.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("molecules"), list):
        return data["molecules"]
    return []


def _install_extension_molecules(M, molecules: list[dict[str, Any]]) -> list[str]:
    """Monkey-patch molecules._LIBRARY_BUILDERS with JSON definitions (active only)."""
    installed: list[str] = []
    for mol in molecules or []:
        if not isinstance(mol, dict):
            continue
        if mol.get("status") == "disabled":
            continue
        sid = str(mol.get("id") or "").strip()
        if not sid:
            continue
        atoms = mol.get("atoms") or []
        bonds = mol.get("bonds") or []
        if not isinstance(atoms, list) or not atoms:
            continue

        def _builder(mol_def=mol, species_id=sid, atoms_def=atoms, bonds_def=bonds):
            return {
                "id": species_id,
                "formula": mol_def.get("formula") or species_id,
                "latex": mol_def.get("latex") or f"\\text{{{species_id}}}",
                "name": mol_def.get("name") or species_id,
                "name_en": mol_def.get("name_en") or species_id,
                "color": mol_def.get("color") or "slate",
                "atoms": [
                    {
                        "slot": a.get("slot"),
                        "el": a.get("el"),
                        "pos": list(a.get("pos") or [0, 0, 0]),
                    }
                    for a in atoms_def
                ],
                "bonds": [
                    {
                        "a": b.get("a"),
                        "b": b.get("b"),
                        "order": b.get("order", 1),
                    }
                    for b in bonds_def
                ],
            }

        M._LIBRARY_BUILDERS[sid] = _builder
        installed.append(sid)
    return installed


def cmd_validate(spec_path: Path, extensions_path: Path | None = None) -> int:
    skill_dir = _find_skill_dir()
    K, M = _load_kernel(skill_dir)
    installed = _install_extension_molecules(M, _load_extensions(extensions_path))
    spec = _read_spec(spec_path)
    try:
        data = K.assemble_data(spec)
        summary = {
            "ok": True,
            "title": (data.get("meta") or {}).get("title") or (spec.get("meta") or {}).get("title") or "",
            "engine": (data.get("meta") or {}).get("engine") or (spec.get("meta") or {}).get("engine") or "",
            "equation": (data.get("meta") or {}).get("equation") or (spec.get("meta") or {}).get("equation") or "",
            "extensions": installed,
        }
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        err = {
            "ok": False,
            "error": str(exc),
            "type": type(exc).__name__,
            "trace": traceback.format_exc(limit=6),
            "extensions": installed,
        }
        print(json.dumps(err, ensure_ascii=False))
        return 2


def cmd_render(spec_path: Path, out_path: Path, extensions_path: Path | None = None) -> int:
    skill_dir = _find_skill_dir()
    K, M = _load_kernel(skill_dir)
    installed = _install_extension_molecules(M, _load_extensions(extensions_path))
    template = skill_dir / "template" / "reaction.html"
    placeholder = "__REACTION_DATA__"
    spec = _read_spec(spec_path)
    try:
        data = K.assemble_data(spec)
        html = template.read_text(encoding="utf-8")
        if placeholder not in html:
            raise RuntimeError(f"template missing placeholder {placeholder}")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(html.replace(placeholder, json.dumps(data, ensure_ascii=False)), encoding="utf-8")
        summary = {
            "ok": True,
            "out": str(out_path),
            "title": (data.get("meta") or {}).get("title") or "",
            "bytes": out_path.stat().st_size,
            "extensions": installed,
        }
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        err = {
            "ok": False,
            "error": str(exc),
            "type": type(exc).__name__,
            "trace": traceback.format_exc(limit=8),
            "extensions": installed,
        }
        print(json.dumps(err, ensure_ascii=False))
        return 2


def cmd_species(extensions_path: Path | None = None) -> int:
    skill_dir = _find_skill_dir()
    _K, M = _load_kernel(skill_dir)
    installed = _install_extension_molecules(M, _load_extensions(extensions_path))
    keys = sorted(getattr(M, "_LIBRARY_BUILDERS", {}).keys())
    print(json.dumps({"ok": True, "species": keys, "extensions": installed}, ensure_ascii=False))
    return 0


def cmd_selfcheck_molecule(mol_path: Path) -> int:
    """Validate a single molecule JSON can be loaded and keyed."""
    skill_dir = _find_skill_dir()
    _K, M = _load_kernel(skill_dir)
    mol = json.loads(mol_path.read_text(encoding="utf-8"))
    if isinstance(mol, dict) and "molecule" in mol:
        mol = mol["molecule"]
    installed = _install_extension_molecules(M, [mol])
    sid = str((mol or {}).get("id") or "")
    try:
        if not sid or sid not in M._LIBRARY_BUILDERS:
            raise RuntimeError("molecule id not installed")
        data = M.get(sid)
        if not data.get("atoms"):
            raise RuntimeError("atoms empty after load")
        print(json.dumps({"ok": True, "id": sid, "slots": [a.get("slot") for a in data.get("atoms") or []], "extensions": installed}, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc), "type": type(exc).__name__}, ensure_ascii=False))
        return 2


def main(argv: list[str]) -> int:
    if not argv or argv[0] in {"-h", "--help", "help"}:
        print(
            "usage: chem_spec_tool.py validate <spec.json> [--extensions file] | "
            "render <spec.json> <out.html> [--extensions file] | "
            "species [--extensions file] | selfcheck-molecule <mol.json>"
        )
        return 1
    cmd = argv[0]
    args = argv[1:]
    extensions_path = None
    if "--extensions" in args:
        i = args.index("--extensions")
        extensions_path = Path(args[i + 1])
        args = args[:i] + args[i + 2 :]

    if cmd == "species":
        return cmd_species(extensions_path)
    if cmd == "validate":
        return cmd_validate(Path(args[0]), extensions_path)
    if cmd == "render":
        return cmd_render(Path(args[0]), Path(args[1]), extensions_path)
    if cmd == "selfcheck-molecule":
        return cmd_selfcheck_molecule(Path(args[0]))
    print(json.dumps({"ok": False, "error": f"unknown command {cmd}"}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
