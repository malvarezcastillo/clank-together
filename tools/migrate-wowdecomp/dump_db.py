"""Dumps the wowdecomp_re MySQL tables the migration needs to JSON (one file per table).

  python dump_db.py <out-dir> [<re-tools-dir>]

Addresses are written as full virtual addresses: tables that keep only the low 32 bits of x64 addresses
(idb_func_x64, status15890_func, map64_15595.ea64) get the 0x100000000 image high bits back.
"""
import json
import os
import sys

OUT = sys.argv[1]
TOOLS = sys.argv[2] if len(sys.argv) > 2 else r"E:\IDA Project\Claude\re\tools"
sys.path.insert(0, TOOLS)
import db  # noqa: E402

HI = 0x100000000
con = db.connect()
os.makedirs(OUT, exist_ok=True)


def dump(name, rows):
    with open(os.path.join(OUT, name + ".json"), "w", encoding="utf-8") as f:
        json.dump(rows, f)
    print("%-22s %7d rows" % (name, len(rows)))


def x64(ea):
    return ea + HI if ea < HI else ea


q = lambda sql: db.query(con, sql)

# Functions of each build: [ea, size, name, flags]
dump("func_15890_x64", [[x64(s), e - s, n, fl] for s, e, n, fl in q("SELECT start_ea, end_ea, name, flags FROM idb_func_x64 WHERE build = 15890")])
dump("func_15595_x64", [[x64(s), e - s, n, fl] for s, e, n, fl in q("SELECT start_ea, end_ea, name, flags FROM idb_func_x64 WHERE build = 15595")])
dump("func_15595_x86", [[s, e - s, n, fl] for s, e, n, fl in q("SELECT start_ea, end_ea, name, flags FROM idb_func WHERE build = 15595")])

# 15890 status: [ea, size, status, module, file]
dump("status15890", [[x64(ea), size, st, mod, f] for ea, size, st, mod, f in q("SELECT ea, size, status, module, file FROM status15890_func")])

# Address maps: 15595 x64 -> 15890 x64, 15595 x86 -> 15595 x64
dump("map_15595_15890", [[x64(a), x64(b), how] for a, b, how in q("SELECT ea15595, ea15890, how FROM map_15595_15890")])
dump("map64_15595", [[a, x64(b), how] for a, b, how in q("SELECT ea15595, ea64, how FROM map64_15595")])

# Byte-match verdicts against 15890 (decorated names of proven functions): [ea, symbol, verdict, file]
dump("byte_match15890", [[x64(ea), sym, v, f] for ea, sym, v, f in q("SELECT ea, symbol, verdict, file FROM byte_match15890_x64")])

# Data symbols by decorated name: [symbol, plain, ea]
dump("data_15890_x64", [[s, p, x64(ea)] for s, p, ea in q("SELECT symbol, plain, ea FROM data15890_x64")])
dump("data_15595_x64", [[s, p, x64(ea)] for s, p, ea in q("SELECT symbol, plain, ea64 FROM data64_15595")])
