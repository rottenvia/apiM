// Ghidra pre-script: runs BEFORE auto-analysis on import.
//
// Applies analyzer overrides chosen by apiM's caller (the model) for THIS
// binary. A JSON config is written beside the project and its path passed as
// the first script argument. The config is:
//
//   { "disable": ["Decompiler Parameter ID", ...],
//     "enable":  ["Some Optional Analyzer", ...] }
//
// A missing/empty file leaves Ghidra's defaults untouched, so the caller can
// keep EVERYTHING enabled (max fidelity) or trim only what it judges
// unnecessary for the job (e.g. skip Decompiler Parameter ID when the
// post-script is already going to decompile the functions it outputs).
//
// When the second argument is a directory path, the full list of available
// analyzers (name + default-enabled) is written there twice: analyzers.txt
// before the overrides, so the model can see exact names before choosing, and
// analyzers-applied.txt after them. Each file opens with a line saying which
// stage it is from and what was asked for, so the two cannot be mixed up.
//
//@category apiM
//@runtime Java

import ghidra.app.script.GhidraScript;
import ghidra.framework.options.Options;

import java.io.File;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

public class ApimAnalysisOptions extends GhidraScript {
  @Override
  public void run() throws Exception {
    Options options = currentProgram.getOptions("Analyzers");

    String[] args = getScriptArgs();

    // First, optionally record every analyzer the installed Ghidra knows
    // about, so a caller can pick exact names without guessing.
    String listDir = args.length >= 2 && args[1] != null && !args[1].isBlank() ? args[1] : null;
    if (listDir != null) {
      // Each list says which stage it is from. Two files of [on]/[off] lines with near-identical names and opposite
      // answers read as a contradiction; a reader comparing them could not tell which one was the truth.
      writeAnalyzerList(options, new File(listDir, "analyzers.txt"),
        "# Ghidra's own defaults for this program, BEFORE apiM applied anything. These are the exact names to pass to"
        + " disable_analyzers/enable_analyzers. What actually ran is in analyzers-applied.txt.");
    }

    if (args.length < 1 || args[0] == null || args[0].isBlank()) {
      return; // no overrides requested - leave Ghidra defaults intact
    }

    // A third argument "raw" means the file was loaded as bytes at an address, with no header. Nothing then points at
    // any code, so "Disassemble Entry Points" — on by default, and the thing that starts every other analyzer off —
    // has nowhere to begin, and the program came back with zero functions however the analyzers were set. The start of
    // each executable block is marked as an entry point here, in the pre-script, so that analysis has a seed to follow.
    // Only for a raw load: a file with a header has its own entry, and seeding a section start would read data as code.
    long seeded = 0;
    boolean rawLoad = args.length >= 3 && "raw".equalsIgnoreCase(args[2]);
    if (rawLoad) {
      seeded = seedEntryPoints();
    }

    File cfg = new File(args[0]);
    if (!cfg.isFile()) return;

    // Minimal JSON parsing for { "disable": [...], "enable": [...] }.
    // Avoids pulling in a JSON library that may not be on the script classpath
    // across Ghidra versions.
    String text = Files.readString(cfg.toPath(), StandardCharsets.UTF_8);
    applyList(text, options, "disable", false);
    applyList(text, options, "enable", true);

    // And again once they are applied. Only the before picture was written, so an override that never arrived looked
    // exactly like one that did, and a reader comparing them had no way to tell which.
    if (listDir != null) {
      writeAnalyzerList(options, new File(listDir, "analyzers-applied.txt"),
        "# What actually ran, AFTER apiM's overrides." +
        "\n# apiM asked to turn off: " + describe(readStringArray(text, "disable")) +
        "\n# apiM asked to turn on: " + describe(readStringArray(text, "enable")) +
        (rawLoad
          ? "\n# Raw load (no header): entry points seeded at " + seeded + " executable block start(s). Nothing in"
            + " a headerless image points at code, so those seeds and whatever the two lines above turn on are all"
            + " the disassembler has to start from. Analyzers named on neither line keep their preset value."
          : "\n# Loaded through a file format loader; no entry points were seeded."));
    }
  }

  /// An override list as it was asked for, for the header of the applied list.
  private String describe(String[] names) {
    if (names == null || names.length == 0) return "(nothing)";
    StringBuilder out = new StringBuilder();
    for (String name : names) {
      String trimmed = name.trim();
      if (trimmed.isEmpty()) continue;
      if (out.length() > 0) out.append(", ");
      out.append(trimmed);
      // Said plainly: an analyzer this Ghidra does not have is the one case where an override silently does nothing.
      if (!options().contains(trimmed)) out.append(" (NOT PRESENT in this Ghidra)");
    }
    return out.length() == 0 ? "(nothing)" : out.toString();
  }

  private Options options() {
    return currentProgram.getOptions("Analyzers");
  }

  /// The first address of every executable block, as an entry point for the disassembler to start from.
  private long seedEntryPoints() {
    long seeded = 0;
    for (ghidra.program.model.mem.MemoryBlock block : currentProgram.getMemory().getBlocks()) {
      if (!block.isExecute()) continue;
      try {
        currentProgram.getSymbolTable().addExternalEntryPoint(block.getStart());
        seeded++;
      } catch (Exception ignored) {
        // A block the symbol table will not take an entry point for is left alone.
      }
    }
    return seeded;
  }

  private void writeAnalyzerList(Options options, File out, String header) throws Exception {
    try (Writer w = Files.newBufferedWriter(out.toPath(), StandardCharsets.UTF_8)) {
      w.write(header + "\n");
      List<String> names = options.getOptionNames();
      java.util.Collections.sort(names, String.CASE_INSENSITIVE_ORDER);
      for (String name : names) {
        boolean enabled = false;
        try {
          enabled = options.getBoolean(name, false);
        } catch (Exception ignored) {
          // Non-boolean option; skip it from the enabled list.
        }
        w.write((enabled ? "[on] " : "[off] ") + name + "\n");
      }
    }
  }

  private void applyList(String text, Options options, String key, boolean value) {
    String[] names = readStringArray(text, key);
    if (names == null) return;
    for (String name : names) {
      String trimmed = name.trim();
      if (trimmed.isEmpty()) continue;
      try {
        if (options.contains(trimmed)) {
          options.setBoolean(trimmed, value);
        }
      } catch (Exception ignored) {
        // Unknown/renamed analyzer across Ghidra versions: leave default.
      }
    }
  }

  /** Extract the string array for `"key": [ ... ]` without a JSON parser. */
  private String[] readStringArray(String json, String key) {
    String needle = "\"" + key + "\"";
    int k = json.indexOf(needle);
    if (k < 0) return null;
    int colon = json.indexOf(':', k + needle.length());
    if (colon < 0) return null;
    int open = json.indexOf('[', colon);
    if (open < 0) return null;
    int depth = 0;
    int close = -1;
    for (int i = open; i < json.length(); i++) {
      char c = json.charAt(i);
      if (c == '[') depth++;
      else if (c == ']') {
        depth--;
        if (depth == 0) { close = i; break; }
      }
    }
    if (close < 0) return null;
    String body = json.substring(open + 1, close);
    // Split on commas, strip quotes/whitespace.
    java.util.ArrayList<String> out = new java.util.ArrayList<>();
    StringBuilder cur = new StringBuilder();
    boolean inStr = false;
    for (int i = 0; i < body.length(); i++) {
      char c = body.charAt(i);
      if (c == '"') { inStr = !inStr; continue; }
      if (c == ',' && !inStr) {
        if (cur.length() > 0) out.add(cur.toString());
        cur.setLength(0);
      } else {
        cur.append(c);
      }
    }
    if (cur.toString().trim().length() > 0) out.add(cur.toString());
    return out.toArray(new String[0]);
  }
}
