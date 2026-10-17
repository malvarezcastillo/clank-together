"""Exports the exact VS2010 x64 command line of every wowdecomp15890 source to config/compile.json.

  python export_compile.py <out compile.json> [<re-tools-dir>]

Uses re/tools/w15890/build2010.py (which takes sources, flags, defines and includes from w15595/build2008.py),
so the coordinator compiles exactly what that script compiles. Machine paths become placeholders:
  ${SRC}  the repository root      ${TC}  the toolchain root (re/toolchain on the original machine)
"""
import json
import os
import sys

OUT = sys.argv[1]
TOOLS = sys.argv[2] if len(sys.argv) > 2 else r"E:\IDA Project\Claude\re\tools"
sys.argv = [sys.argv[0]]
sys.path.insert(0, os.path.join(TOOLS, "w15890"))
import build2010 as b  # noqa: E402

SRC = os.path.normpath(b.b8.SRC)
TC = os.path.normpath(os.path.join(b.ROOT, "re", "toolchain"))


def place(arg):
    for real, ph in ((SRC, "${SRC}"), (TC, "${TC}")):
        for variant in (real, real.replace("\\", "/")):
            if variant in arg:
                arg = arg.replace(variant, ph)
    return arg


shapes, index, units = [], {}, {}
for path, mod in b.b8.sources():
    _obj, cmd = b.b8.command(path, mod)
    cmd = ["/I" + b.COMPAT, "/FI" + os.path.join(b.COMPAT, "vs2010_compat.h")] + cmd
    args = [place(c) for c in cmd if not c.startswith("/Fo") and os.path.normpath(c) != os.path.normpath(path)]
    key = json.dumps(args)
    if key not in index:
        index[key] = len(shapes)
        shapes.append(args)
    units[os.path.relpath(path, SRC).replace("\\", "/")] = index[key]

env = {"INCLUDE": ";".join(place(p) for p in (b.VCINC, b.SDKINC))}
compiler = place(b.CL)
leftover = [a for s in shapes for a in s if ":\\" in a or ":/" in a]
if leftover:
    raise SystemExit("unplaced machine paths: %s" % leftover[:5])
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump({"compiler": compiler, "env": env, "shapes": shapes, "units": dict(sorted(units.items()))}, f, indent=1)
print("units %d, shapes %d, compiler %s" % (len(units), len(shapes), compiler))
