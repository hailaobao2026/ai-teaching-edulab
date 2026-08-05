#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate/render edu-analytic-geometry lesson specs for AI pipeline (M3)."""

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
        root / "node_modules" / "@wy51ai" / "edulab" / "skills" / "edu-analytic-geometry",
        root / "skills" / "edu-analytic-geometry",
    ]
    for c in candidates:
        if (c / "scripts" / "generate.py").exists() and (c / "template" / "board.html").exists():
            return c
    raise FileNotFoundError("edu-analytic-geometry skill not found")


def _read_json(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "payload" in data and isinstance(data["payload"], dict):
        return data["payload"]
    return data


def _as_pair(v: Any, name: str) -> list[float]:
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        raise ValueError(f"{name} 必须是长度为 2 的数组")
    return [float(v[0]), float(v[1])]


def _validate_conic(c: dict, idx: int) -> None:
    if not isinstance(c, dict):
        raise ValueError(f"conics[{idx}] 不是对象")
    kind = str(c.get("kind") or "").lower()
    if kind not in {"ellipse", "hyperbola", "parabola", "circle"}:
        raise ValueError(f"conics[{idx}].kind 非法: {kind}")
    center = c.get("center", [0, 0])
    _as_pair(center, f"conics[{idx}].center")
    if kind in {"ellipse", "hyperbola"}:
        if float(c.get("a", 0)) <= 0 or float(c.get("b", 0)) <= 0:
            raise ValueError(f"conics[{idx}] a/b 必须 > 0")
        if kind == "hyperbola" and str(c.get("orient", "x")) not in {"x", "y"}:
            raise ValueError(f"conics[{idx}].orient 必须是 x 或 y")
    elif kind == "circle":
        if float(c.get("r", 0)) <= 0:
            raise ValueError(f"conics[{idx}].r 必须 > 0")
    elif kind == "parabola":
        if float(c.get("p", 0)) == 0:
            raise ValueError(f"conics[{idx}].p 不能为 0")
        if str(c.get("axis", "x")) not in {"x", "y"}:
            raise ValueError(f"conics[{idx}].axis 必须是 x 或 y")


def validate_spec(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ValueError("spec 必须是对象")
    lesson = data.get("lesson")
    steps = data.get("steps")
    board = data.get("board")
    if not isinstance(lesson, dict):
        raise ValueError("lesson 必填")
    if not isinstance(steps, list) or not steps:
        raise ValueError("steps 必须非空数组")
    if not isinstance(board, dict):
        raise ValueError("board 必填")

    if not str(lesson.get("title") or "").strip():
        raise ValueError("lesson.title 必填")
    if not str(lesson.get("problem") or "").strip():
        raise ValueError("lesson.problem 必填")

    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError(f"steps[{i}] 不是对象")
        if not str(step.get("title") or "").strip():
            raise ValueError(f"steps[{i}].title 必填")
        if not str(step.get("content") or step.get("html") or "").strip():
            raise ValueError(f"steps[{i}].content 必填")

    view = board.get("view") or {}
    if not isinstance(view, dict):
        raise ValueError("board.view 必填")
    xr = _as_pair(view.get("xRange"), "board.view.xRange")
    yr = _as_pair(view.get("yRange"), "board.view.yRange")
    if xr[0] >= xr[1] or yr[0] >= yr[1]:
        raise ValueError("view 范围上下界非法")

    conics = board.get("conics")
    if not isinstance(conics, list) or not conics:
        raise ValueError("board.conics 至少 1 条曲线")
    for i, c in enumerate(conics):
        _validate_conic(c, i)

    # points optional
    points = board.get("points")
    if points is not None and not isinstance(points, dict):
        raise ValueError("board.points 必须是对象")

    # optional display widgets: at most soft check
    widgets = [k for k in ("rangeBar", "constant", "answerBand") if board.get(k)]
    # param optional
    param = board.get("param")
    if param is not None:
        if not isinstance(param, dict):
            raise ValueError("board.param 必须是对象")
        for key in ("min", "max", "step", "value"):
            if key in param:
                float(param[key])
        if "min" in param and "max" in param and float(param["min"]) > float(param["max"]):
            raise ValueError("param.min > param.max")

    return {
        "ok": True,
        "title": lesson.get("title") or "",
        "steps": len(steps),
        "conics": len(conics),
        "widgets": widgets,
        "language": lesson.get("language") or "zh-CN",
    }


def normalize_for_render(data: dict) -> dict:
    """Ensure steps use content field expected by template."""
    out = {
        "lesson": dict(data.get("lesson") or {}),
        "steps": [],
        "board": dict(data.get("board") or {}),
    }
    for step in data.get("steps") or []:
        out["steps"].append({
            "title": step.get("title") or "步骤",
            "content": step.get("content") or step.get("html") or "",
        })
    return out


def cmd_validate(spec_path: Path) -> int:
    try:
        data = _read_json(spec_path)
        summary = validate_spec(data)
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({
            "ok": False,
            "error": str(exc),
            "type": type(exc).__name__,
            "trace": traceback.format_exc(limit=6),
        }, ensure_ascii=False))
        return 2


def cmd_render(spec_path: Path, out_path: Path) -> int:
    skill_dir = _find_skill_dir()
    sys.path.insert(0, str(skill_dir / "scripts"))
    import generate as G  # noqa: WPS433

    try:
        data = normalize_for_render(_read_json(spec_path))
        summary = validate_spec(data)
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        G.render_html(data, out_path)
        print(json.dumps({
            "ok": True,
            "out": str(out_path),
            "title": summary.get("title") or "",
            "bytes": out_path.stat().st_size,
            "steps": summary.get("steps"),
            "conics": summary.get("conics"),
        }, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({
            "ok": False,
            "error": str(exc),
            "type": type(exc).__name__,
            "trace": traceback.format_exc(limit=8),
        }, ensure_ascii=False))
        return 2


def main(argv: list[str]) -> int:
    if not argv or argv[0] in {"-h", "--help", "help"}:
        print("usage: analytic_spec_tool.py validate <spec.json> | render <spec.json> <out.html>")
        return 1
    cmd = argv[0]
    if cmd == "validate":
        return cmd_validate(Path(argv[1]))
    if cmd == "render":
        return cmd_render(Path(argv[1]), Path(argv[2]))
    print(json.dumps({"ok": False, "error": f"unknown command {cmd}"}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
