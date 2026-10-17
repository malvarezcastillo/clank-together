// Exports every function of the program as CSV (addr,size,name,library) for
// `td-server symbols import`. Run headless after auto-analysis, e.g.
//   analyzeHeadless <dir> bootstrap -import game.exe -scriptPath ghidra_scripts \
//       -postScript ExportFunctions.java functions.csv
// Functions identified by the Function ID analyzer are flagged as library code.
// @category ClankTogether

import java.io.PrintWriter;

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressRange;
import ghidra.program.model.listing.Bookmark;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;

public class ExportFunctions extends GhidraScript {

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) {
            printerr("usage: ExportFunctions.java <output.csv>");
            return;
        }
        int count = 0;
        try (PrintWriter out = new PrintWriter(args[0], "UTF-8")) {
            out.println("# addr,size,name,library");
            FunctionIterator it = currentProgram.getFunctionManager().getFunctions(true);
            while (it.hasNext() && !monitor.isCancelled()) {
                Function f = it.next();
                if (f.isExternal() || f.isThunk()) {
                    continue;
                }
                Address entry = f.getEntryPoint();
                // Size of the contiguous range starting at the entry point.
                long size = f.getBody().getNumAddresses();
                for (AddressRange r : f.getBody()) {
                    if (r.contains(entry)) {
                        size = r.getMaxAddress().subtract(entry) + 1;
                        break;
                    }
                }
                String name = f.getName(true).replace(",", "_");
                if (name.startsWith("FUN_")) {
                    name = "";
                }
                out.printf("0x%08x,%d,%s,%d%n", entry.getOffset(), size, name, isLibrary(entry) ? 1 : 0);
                count++;
            }
        }
        println("exported " + count + " functions to " + args[0]);
    }

    private boolean isLibrary(Address entry) {
        for (Bookmark b : currentProgram.getBookmarkManager().getBookmarks(entry)) {
            if ("Function ID Analyzer".equals(b.getCategory())) {
                return true;
            }
        }
        return false;
    }
}
