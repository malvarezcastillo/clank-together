// Writes the decompiler output of the function containing an address to a file.
// Args: <hex address> <output file>
// @category ClankTogether

import java.io.PrintWriter;

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;

public class DecompileAt extends GhidraScript {

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        Function f = getFunctionContaining(toAddr(Long.decode(args[0])));
        try (PrintWriter out = new PrintWriter(args[1], "UTF-8")) {
            if (f == null) {
                out.println("// no function at " + args[0]);
                return;
            }
            DecompInterface ifc = new DecompInterface();
            try {
                ifc.openProgram(currentProgram);
                DecompileResults r = ifc.decompileFunction(f, 120, monitor);
                if (!r.decompileCompleted()) {
                    out.println("// decompilation failed: " + r.getErrorMessage());
                    return;
                }
                out.println("// " + f.getName(true) + " @ " + f.getEntryPoint() + " (Ghidra output, not matching code)");
                out.print(r.getDecompiledFunction().getC());
            } finally {
                ifc.dispose();
            }
        }
    }
}
