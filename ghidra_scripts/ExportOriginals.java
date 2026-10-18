// Exports the disassembly and the decompiler output of every function as JSON lines, for the
// coordinator's /api/original (contributors then need no local Ghidra):
//   {"addr":"0x140099b90","asm":"...","c":"..."}
// Args: <output.jsonl> [decompile timeout seconds, default 30]
// Run on a project built with `td ghidra build` (symbol names applied), with -readOnly.
// @category ClankTogether

import java.io.BufferedWriter;
import java.io.OutputStreamWriter;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.Symbol;

public class ExportOriginals extends GhidraScript {

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        int timeout = args.length > 1 ? Integer.parseInt(args[1]) : 30;
        DecompInterface ifc = new DecompInterface();
        ifc.openProgram(currentProgram);
        int n = 0;
        int failed = 0;
        try (BufferedWriter out = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(args[0]), StandardCharsets.UTF_8))) {
            FunctionIterator it = currentProgram.getFunctionManager().getFunctions(true);
            while (it.hasNext() && !monitor.isCancelled()) {
                Function f = it.next();
                if (f.isExternal() || f.isThunk()) {
                    continue;
                }
                String c;
                DecompileResults r = ifc.decompileFunction(f, timeout, monitor);
                if (r.decompileCompleted() && r.getDecompiledFunction() != null) {
                    c = r.getDecompiledFunction().getC();
                } else {
                    c = null;
                    failed++;
                }
                out.write("{\"addr\":\"0x" + Long.toHexString(f.getEntryPoint().getOffset()) + "\",\"asm\":" + json(disassemble(f)) + ",\"c\":" + (c == null ? "null" : json(c)) + "}\n");
                if (++n % 1000 == 0) {
                    println("exported " + n + " functions");
                }
            }
        } finally {
            ifc.dispose();
        }
        println("exported " + n + " functions, " + failed + " without decompiler output");
    }

    private String disassemble(Function f) {
        StringBuilder sb = new StringBuilder();
        Address entry = f.getEntryPoint();
        sb.append("; ").append(f.getName(true)).append(" @ ").append(entry).append("  ").append(f.getSignature().getPrototypeString()).append('\n');
        InstructionIterator it = currentProgram.getListing().getInstructions(f.getBody(), true);
        while (it.hasNext()) {
            Instruction insn = it.next();
            Address a = insn.getAddress();
            if (!a.equals(entry)) {
                for (Symbol s : currentProgram.getSymbolTable().getSymbols(a)) {
                    sb.append(s.getName(true)).append(":\n");
                }
            }
            StringBuilder bytes = new StringBuilder();
            try {
                for (byte b : insn.getBytes()) {
                    bytes.append(String.format("%02x ", b & 0xff));
                }
            } catch (Exception e) {
                bytes.append("?? ");
            }
            StringBuilder refs = new StringBuilder();
            for (Reference ref : insn.getReferencesFrom()) {
                Symbol s = currentProgram.getSymbolTable().getPrimarySymbol(ref.getToAddress());
                if (s != null) {
                    refs.append(" ; -> ").append(s.getName(true));
                }
            }
            sb.append(String.format("  +0x%04x %08x  %-24s %s%s%n", a.subtract(entry), a.getOffset(), bytes.toString().trim(), insn.toString(), refs));
        }
        return sb.toString();
    }

    private static String json(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (ch < 0x20) {
                        sb.append(String.format("\\u%04x", (int) ch));
                    } else {
                        sb.append(ch);
                    }
            }
        }
        return sb.append('"').toString();
    }
}
