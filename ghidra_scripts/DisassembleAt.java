// Writes the disassembly (address, bytes, instruction, labels) of the function
// containing an address to a file.
// Args: <hex address> <output file>
// @category ClankTogether

import java.io.PrintWriter;

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.symbol.Symbol;

public class DisassembleAt extends GhidraScript {

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        Function f = getFunctionContaining(toAddr(Long.decode(args[0])));
        try (PrintWriter out = new PrintWriter(args[1], "UTF-8")) {
            if (f == null) {
                out.println("; no function at " + args[0]);
                return;
            }
            Address entry = f.getEntryPoint();
            out.println("; " + f.getName(true) + " @ " + entry + "  " + f.getSignature().getPrototypeString());
            InstructionIterator it = currentProgram.getListing().getInstructions(f.getBody(), true);
            while (it.hasNext()) {
                Instruction insn = it.next();
                Address a = insn.getAddress();
                for (Symbol s : currentProgram.getSymbolTable().getSymbols(a)) {
                    if (!a.equals(entry)) {
                        out.println(s.getName(true) + ":");
                    }
                }
                StringBuilder bytes = new StringBuilder();
                for (byte b : insn.getBytes()) {
                    bytes.append(String.format("%02x ", b & 0xff));
                }
                String refs = "";
                for (var ref : insn.getReferencesFrom()) {
                    Symbol s = currentProgram.getSymbolTable().getPrimarySymbol(ref.getToAddress());
                    if (s != null) {
                        refs += " ; -> " + s.getName(true);
                    }
                }
                out.printf("  +0x%04x %08x  %-24s %s%s%n", a.subtract(entry), a.getOffset(), bytes.toString().trim(), insn.toString(), refs);
            }
        }
    }
}
