// Ghidra pre-script: runs BEFORE auto-analysis on import.
//
// We do not need every analyzer. The expensive ones that provide no value for
// what apiM reports - in particular "Decompiler Parameter ID", which
// decompiles EVERY function during analysis, and "Decompiler Switch Analysis"
// - are turned off here. Our post-script (ApimDecompile.java) decompiles only
// the functions we actually output. Everything the summary/strings/artifacts
// show is unaffected: references, strings, functions, data types and the
// decompiled bodies we emit are all produced by the analyzers left enabled.
//
// Result: a large binary analyses dramatically faster with no loss of
// reported information.
//@category apiM
//@runtime Java

import ghidra.app.script.GhidraScript;
import ghidra.framework.options.Options;

public class ApimAnalysisOptions extends GhidraScript {
  @Override
  public void run() throws Exception {
    Options options = currentProgram.getOptions("Analyzers");

    // Analyzers that add time but whose results we never surface.
    String[] disabled = new String[] {
      "Decompiler Parameter ID",
      "Decompiler Switch Analysis",
      "Stack", // fixed by our own linear-sweep of .pdata on PE; Ghidra's is slow
    };
    for (String name : disabled) {
      try {
        if (options.contains(name)) {
          options.setBoolean(name, false);
        }
      } catch (Exception ignored) {
        // An analyzer name that is absent/renamed across Ghidra versions is
        // harmless - leave whatever default it has.
      }
    }
  }
}
