// Applies the Clank Together symbol snapshot to the program, so every
// contributor's local Ghidra project shows the same names.
// Input: TSV lines "addr kind id name decorated library" written by `td ghidra build/sync`.
// @category ClankTogether

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;

import ghidra.app.script.GhidraScript;
import ghidra.app.util.NamespaceUtils;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.CodeUnit;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Namespace;
import ghidra.program.model.symbol.SourceType;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolUtilities;

public class ApplySymbols extends GhidraScript {

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) {
            printerr("usage: ApplySymbols.java <symbols.tsv>");
            return;
        }
        List<String> lines = Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8);
        int applied = 0;
        int failed = 0;
        for (String line : lines) {
            if (monitor.isCancelled()) {
                break;
            }
            String[] c = line.split("\t", -1);
            if (c.length < 6) {
                continue;
            }
            try {
                Address addr = toAddr(Long.parseLong(c[0], 16));
                apply(addr, c[1], c[2], c[3]);
                applied++;
            } catch (Exception e) {
                failed++;
                printerr("could not apply " + line + ": " + e.getMessage());
            }
        }
        println("applied " + applied + " symbols, " + failed + " failed");
    }

    private void apply(Address addr, String kind, String id, String name) throws Exception {
        String label = name.isEmpty() ? id : name;
        if (kind.equals("function")) {
            Function f = getFunctionAt(addr);
            if (f == null) {
                disassemble(addr);
                f = createFunction(addr, null);
            }
            if (f != null) {
                setName(f.getSymbol(), label);
            }
        } else {
            Symbol s = getSymbolAt(addr);
            if (s == null || s.getSource() == SourceType.DEFAULT) {
                s = createLabel(addr, SymbolUtilities.replaceInvalidChars(id, true), true, SourceType.USER_DEFINED);
            }
            setName(s, label);
        }
        currentProgram.getListing().setComment(addr, CodeUnit.PLATE_COMMENT, "TD " + id);
    }

    /** Uses "A::B::name" as a namespace path when possible, else a flat sanitized name. */
    private void setName(Symbol s, String qualified) throws Exception {
        int split = qualified.lastIndexOf("::");
        if (split > 0 && !qualified.contains("<")) {
            try {
                Namespace ns = NamespaceUtils.createNamespaceHierarchy(qualified.substring(0, split), null, currentProgram, SourceType.USER_DEFINED);
                s.setNameAndNamespace(SymbolUtilities.replaceInvalidChars(qualified.substring(split + 2), true), ns, SourceType.USER_DEFINED);
                return;
            } catch (Exception e) {
                // fall through to a flat name
            }
        }
        s.setName(SymbolUtilities.replaceInvalidChars(qualified, true), SourceType.USER_DEFINED);
    }
}
