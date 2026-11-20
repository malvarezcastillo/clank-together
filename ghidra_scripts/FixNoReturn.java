// Recovers code that auto-analysis dropped from function bodies, so td disasm/decompile show it:
// 1. Clears the non-returning flag on functions that return. Analysis marks a function noreturn when
//    one path ends in a noreturn call (std::_Xlength_error and the like) even if another reaches a RET;
//    every caller then loses the instructions after the call.
// 2. Resolves `jmp [reg*4 + table]` switches whose table analysis left unread: entries are taken while
//    they point into the function's own address range, and each target is disassembled.
// @category ClankTogether

import java.util.ArrayList;
import java.util.List;

import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.app.cmd.function.CreateFunctionCmd;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.symbol.FlowType;
import ghidra.program.model.symbol.Reference;
import ghidra.app.script.GhidraScript;

public class FixNoReturn extends GhidraScript {

    @Override
    protected void run() throws Exception {
        List<Function> cleared = new ArrayList<>();
        FunctionIterator fit = currentProgram.getFunctionManager().getFunctions(true);
        while (fit.hasNext() && !monitor.isCancelled()) {
            Function f = fit.next();
            if (!f.hasNoReturn() || f.isExternal() || f.isThunk() || !returns(f)) {
                continue;
            }
            f.setNoReturn(false);
            cleared.add(f);
        }

        int callers = 0;
        for (Function f : cleared) {
            for (Reference ref : getReferencesTo(f.getEntryPoint())) {
                if (!ref.getReferenceType().isCall()) {
                    continue;
                }
                Instruction call = getInstructionAt(ref.getFromAddress());
                if (call == null) {
                    continue;
                }
                call.setFlowOverride(ghidra.program.model.listing.FlowOverride.NONE);
                call.clearFallThroughOverride();
                Address next = call.getMaxAddress().next();
                if (next != null && getInstructionAt(next) == null) {
                    new DisassembleCommand(next, null, true).applyTo(currentProgram, monitor);
                }
                Function caller = getFunctionContaining(call.getAddress());
                if (caller != null) {
                    CreateFunctionCmd.fixupFunctionBody(currentProgram, caller, monitor);
                    callers++;
                }
            }
        }
        int switches = resolveJumpTables();
        println("cleared noreturn on " + cleared.size() + " functions, re-flowed " + callers + " call sites, resolved " + switches + " jump tables");
        for (Function f : cleared) {
            println("  " + f.getEntryPoint() + " " + f.getName(true));
        }
    }

    private int resolveJumpTables() throws Exception {
        int resolved = 0;
        FunctionIterator fit = currentProgram.getFunctionManager().getFunctions(true);
        while (fit.hasNext() && !monitor.isCancelled()) {
            Function f = fit.next();
            if (f.isExternal() || f.isThunk()) {
                continue;
            }
            List<Instruction> jumps = new ArrayList<>();
            InstructionIterator it = currentProgram.getListing().getInstructions(f.getBody(), true);
            while (it.hasNext()) {
                Instruction insn = it.next();
                if (insn.getFlowType().isJump() && insn.getFlowType().isComputed() && insn.getMnemonicString().equalsIgnoreCase("JMP")) {
                    jumps.add(insn);
                }
            }
            for (Instruction jump : jumps) {
                if (resolveJumpTable(f, jump)) {
                    resolved++;
                }
            }
        }
        return resolved;
    }

    private boolean resolveJumpTable(Function f, Instruction jump) throws Exception {
        Address table = null;
        for (Reference ref : jump.getReferencesFrom()) {
            if (ref.getReferenceType().isData()) {
                table = ref.getToAddress();
            }
        }
        if (table == null || jump.getFlows().length > 0) {
            return false;
        }
        long low = f.getEntryPoint().getOffset();
        long high = table.getOffset();
        if (high <= low || high - low > 0x100000) {
            return false;
        }
        List<Address> targets = new ArrayList<>();
        for (Address at = table;; at = at.add(4)) {
            long target = getInt(at) & 0xffffffffL;
            if (target < low || target >= high) {
                break;
            }
            targets.add(toAddr(target));
        }
        if (targets.isEmpty()) {
            return false;
        }
        for (Address target : targets) {
            jump.addOperandReference(0, target, ghidra.program.model.symbol.RefType.COMPUTED_JUMP, ghidra.program.model.symbol.SourceType.ANALYSIS);
            if (getInstructionAt(target) == null) {
                new DisassembleCommand(target, null, true).applyTo(currentProgram, monitor);
            }
        }
        CreateFunctionCmd.fixupFunctionBody(currentProgram, f, monitor);
        return true;
    }

    /** Whether the function body holds a RET instruction (some path returns to its caller). */
    private boolean returns(Function f) {
        InstructionIterator it = currentProgram.getListing().getInstructions(f.getBody(), true);
        while (it.hasNext()) {
            Instruction insn = it.next();
            FlowType flow = insn.getFlowType();
            if (flow.isTerminal() && insn.getMnemonicString().toUpperCase().startsWith("RET")) {
                return true;
            }
        }
        return false;
    }
}
