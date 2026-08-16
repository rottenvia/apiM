// Ghidra headless post-script used by apiM's inspect_binary tool.
//
// This script never runs the imported program. It can either decompile the
// whole program into searchable chunks or first resolve symbols/strings named
// by focus terms and decompile only their referencing functions.

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public class ApimDecompile extends GhidraScript {
    private static final int CHUNK_CHARS = 350_000;
    private static final int MAX_FUNCTIONS = 100_000;

    private BufferedWriter chunk;
    private int chunkNumber = 0;
    private int chunkChars = 0;
    private long totalChars = 0;
    private long maxChars;
    private File outputDir;

    private static String safe(String value) {
        if (value == null) return "";
        return value.replace("\t", " ").replace("\r", " ").replace("\n", " ");
    }

    private static long outputCap() {
        String raw = System.getenv("APIM_BINARY_MAX_OUTPUT_MB");
        try {
            long mb = raw == null ? 100 : Long.parseLong(raw);
            mb = Math.max(10, Math.min(500, mb));
            return mb * 1024L * 1024L;
        } catch (Exception ignored) {
            return 100L * 1024L * 1024L;
        }
    }

    private void openChunk() throws Exception {
        closeChunk();
        chunkNumber++;
        chunkChars = 0;
        File file = new File(outputDir, String.format("decompiled-%04d.c", chunkNumber));
        chunk = new BufferedWriter(
            new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8),
            128 * 1024
        );
        String header =
            "/* apiM / Ghidra C-like decompilation chunk " + chunkNumber + "\n" +
            " * Approximate recovered code: types, names and control flow may differ from source.\n" +
            " * The imported executable was analysed, never executed.\n" +
            " */\n\n";
        chunk.write(header);
        chunkChars += header.length();
        totalChars += header.length();
    }

    private void closeChunk() throws Exception {
        if (chunk != null) {
            chunk.flush();
            chunk.close();
            chunk = null;
        }
    }

    private boolean writeFunction(String text) throws Exception {
        if (totalChars + text.length() > maxChars) return false;
        if (chunk == null || (chunkChars > 0 && chunkChars + text.length() > CHUNK_CHARS)) {
            openChunk();
        }
        chunk.write(text);
        chunkChars += text.length();
        totalChars += text.length();
        return true;
    }

    private Set<String> termsIn(String text, List<String> terms) {
        Set<String> found = new LinkedHashSet<>();
        String lower = text == null ? "" : text.toLowerCase(Locale.ROOT);
        for (String term : terms) {
            if (lower.contains(term.toLowerCase(Locale.ROOT))) found.add(term);
        }
        return found;
    }

    private void addReferenceFunctions(
        Address destination,
        String term,
        Map<Function, Set<String>> focused
    ) {
        ReferenceIterator refs = currentProgram.getReferenceManager().getReferencesTo(destination);
        while (refs.hasNext() && !monitor.isCancelled()) {
            Reference ref = refs.next();
            Function owner = currentProgram.getFunctionManager().getFunctionContaining(ref.getFromAddress());
            if (owner != null) {
                focused.computeIfAbsent(owner, ignored -> new LinkedHashSet<>()).add(term);
            }
        }
    }

    /** Resolve focus by function/symbol name and by references to matching data strings. */
    private Map<Function, Set<String>> collectFocused(List<String> terms) {
        Map<Function, Set<String>> focused = new LinkedHashMap<>();
        FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
        while (functions.hasNext() && !monitor.isCancelled()) {
            Function function = functions.next();
            Set<String> matches = termsIn(
                function.getName(true) + " " + function.getSignature().getPrototypeString(),
                terms
            );
            if (!matches.isEmpty()) {
                focused.computeIfAbsent(function, ignored -> new LinkedHashSet<>()).addAll(matches);
            }
        }

        SymbolIterator symbols = currentProgram.getSymbolTable().getAllSymbols(true);
        while (symbols.hasNext() && !monitor.isCancelled()) {
            Symbol symbol = symbols.next();
            Set<String> matches = termsIn(symbol.getName(true), terms);
            if (matches.isEmpty()) continue;
            Function own = currentProgram.getFunctionManager().getFunctionContaining(symbol.getAddress());
            if (own != null) {
                focused.computeIfAbsent(own, ignored -> new LinkedHashSet<>()).addAll(matches);
            }
            for (String term : matches) addReferenceFunctions(symbol.getAddress(), term, focused);
        }

        DataIterator dataItems = currentProgram.getListing().getDefinedData(true);
        while (dataItems.hasNext() && !monitor.isCancelled()) {
            Data data = dataItems.next();
            Object value = data.getValue();
            if (value == null) continue;
            Set<String> matches = termsIn(value.toString(), terms);
            for (String term : matches) addReferenceFunctions(data.getAddress(), term, focused);
        }
        return focused;
    }

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) {
            throw new IllegalArgumentException("ApimDecompile needs an output directory");
        }
        outputDir = new File(args[0]);
        if (!outputDir.exists() && !outputDir.mkdirs()) {
            throw new IllegalStateException("Could not create " + outputDir);
        }
        boolean focusedOnly = args.length > 1 && "focused".equalsIgnoreCase(args[1]);
        List<String> focusTerms = new ArrayList<>();
        for (int i = 2; i < args.length; i++) {
            String term = args[i].trim();
            if (!term.isEmpty() && focusTerms.size() < 32) focusTerms.add(term);
        }
        maxChars = outputCap();

        File indexFile = new File(outputDir, "functions.tsv");
        File focusIndexFile = new File(outputDir, "focused-functions.tsv");
        File focusCodeFile = new File(outputDir, "focused-functions.c");
        File summaryFile = new File(outputDir, "summary.txt");
        int total = 0;
        int completed = 0;
        int failed = 0;
        int focusedCount = 0;
        boolean capped = false;

        DecompInterface decompiler = new DecompInterface();
        DecompileOptions options = new DecompileOptions();
        decompiler.setOptions(options);
        decompiler.toggleCCode(true);
        decompiler.toggleSyntaxTree(true);
        decompiler.setSimplificationStyle("decompile");
        if (!decompiler.openProgram(currentProgram)) {
            throw new IllegalStateException("Ghidra decompiler could not open the imported program");
        }

        Map<Function, Set<String>> focused = collectFocused(focusTerms);
        List<Function> work = new ArrayList<>();
        boolean fallbackBehavior = false;
        boolean fallbackFull = false;
        if (focusedOnly) {
            work.addAll(focused.keySet());
            /*
             * Stripped/packed programs often contain neither original symbol
             * names nor the macro text the user knows from source. First find
             * callers of loader, process-memory and process-creation APIs —
             * those are the functions most likely to unpack/launch a payload
             * and are far cheaper to decompile than the entire program.
             */
            if (work.isEmpty()) {
                List<String> behaviorTerms = List.of(
                    "CreateRemoteThread", "WriteProcessMemory", "ReadProcessMemory",
                    "VirtualAlloc", "VirtualAllocEx", "VirtualProtect",
                    "LoadLibrary", "GetProcAddress", "CreateProcess",
                    "NtWriteVirtualMemory", "NtMapViewOfSection", "QueueUserAPC",
                    "SetThreadContext", "ResumeThread", "RtlDecompressBuffer"
                );
                Map<Function, Set<String>> behavior = collectFocused(behaviorTerms);
                if (!behavior.isEmpty()) {
                    fallbackBehavior = true;
                    focused = behavior;
                    work.addAll(behavior.keySet());
                }
            }
            /* No names, strings, imports or references survived: only now pay
             * for bounded full decompilation rather than returning emptiness. */
            if (work.isEmpty()) {
                fallbackFull = true;
                FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
                while (functions.hasNext() && work.size() < MAX_FUNCTIONS) {
                    work.add(functions.next());
                }
            }
        } else {
            FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
            while (functions.hasNext() && work.size() < MAX_FUNCTIONS) work.add(functions.next());
        }
        final boolean writeFullOutput = !focusedOnly || fallbackFull;
        Collections.sort(
            work,
            (left, right) -> left.getEntryPoint().compareTo(right.getEntryPoint())
        );

        try (
            BufferedWriter index = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(indexFile), StandardCharsets.UTF_8),
                128 * 1024
            );
            BufferedWriter focusIndex = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(focusIndexFile), StandardCharsets.UTF_8),
                128 * 1024
            );
            BufferedWriter focusCode = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(focusCodeFile), StandardCharsets.UTF_8),
                128 * 1024
            )
        ) {
            index.write("address\tname\tnamespace\tstatus\tchunk\tsignature\n");
            focusIndex.write("address\tname\tmatched_terms\tsignature\n");
            focusCode.write(
                "/* apiM focused Ghidra decompilation\n" +
                " * Terms: " + String.join(", ", focusTerms) + "\n" +
                " * Target executed: false\n */\n\n"
            );

            for (Function function : work) {
                if (total >= MAX_FUNCTIONS || monitor.isCancelled()) break;
                total++;
                String address = function.getEntryPoint().toString();
                String name = safe(function.getName());
                String namespace = safe(function.getParentNamespace().getName(true));
                String signature = safe(function.getSignature().getPrototypeString());

                DecompileResults result = decompiler.decompileFunction(function, 60, monitor);
                if (!result.decompileCompleted() || result.getDecompiledFunction() == null) {
                    failed++;
                    index.write(address + "\t" + name + "\t" + namespace + "\tfailed\t\t" + signature + "\n");
                    continue;
                }

                String code = result.getDecompiledFunction().getC();
                Set<String> matched = new LinkedHashSet<>();
                Set<String> preResolved = focused.get(function);
                if (preResolved != null) matched.addAll(preResolved);
                matched.addAll(termsIn(code, focusTerms));
                String block =
                    "/* " + namespace + "::" + name + " @ " + address + " */\n" +
                    code + "\n\n";

                String chunkName = "";
                if (writeFullOutput && !capped) {
                    int destinationChunk = chunkNumber;
                    if (chunk == null || chunkChars + block.length() > CHUNK_CHARS) destinationChunk++;
                    if (!writeFunction(block)) capped = true;
                    else chunkName = String.format("decompiled-%04d.c", destinationChunk);
                }
                completed++;
                index.write(
                    address + "\t" + name + "\t" + namespace + "\tdecompiled\t" +
                    chunkName + "\t" + signature + "\n"
                );

                if (!matched.isEmpty()) {
                    focusedCount++;
                    focusIndex.write(
                        address + "\t" + name + "\t" + String.join(",", matched) + "\t" + signature + "\n"
                    );
                    focusCode.write(
                        "/* Matched: " + String.join(", ", matched) + " */\n" + block
                    );
                }
            }
            if (focusedCount == 0) {
                focusCode.write(
                    "/* No surviving symbol/string reference matched the requested terms.\n" +
                    (fallbackBehavior
                        ? " * Behavior/API fallback candidates were selected, but none decompiled successfully.\n"
                        : fallbackFull
                            ? " * Full decompilation was generated as a fallback; search those chunks by behavior/API instead.\n"
                            : "") +
                    " */\n"
                );
            }
        } finally {
            closeChunk();
            decompiler.dispose();
        }

        try (BufferedWriter summary = new BufferedWriter(
            new OutputStreamWriter(new FileOutputStream(summaryFile), StandardCharsets.UTF_8)
        )) {
            summary.write("Program: " + currentProgram.getName() + "\n");
            summary.write("Language: " + currentProgram.getLanguageID() + "\n");
            summary.write("Compiler: " + currentProgram.getCompilerSpec().getCompilerSpecID() + "\n");
            summary.write(
                "Mode: " +
                (fallbackFull
                    ? "focused-miss-fallback-full"
                    : fallbackBehavior
                        ? "focused-miss-fallback-behavior"
                        : focusedOnly ? "focused-only" : "full-plus-focused") +
                "\n"
            );
            summary.write("Focus terms: " + String.join(", ", focusTerms) + "\n");
            summary.write("Behavior fallback used: " + fallbackBehavior + "\n");
            summary.write("Full fallback used: " + fallbackFull + "\n");
            summary.write("Functions selected/visited: " + total + "\n");
            summary.write("Functions decompiled: " + completed + "\n");
            summary.write("Focused functions: " + focusedCount + "\n");
            summary.write("Functions failed: " + failed + "\n");
            summary.write("Full-output chunks: " + chunkNumber + "\n");
            summary.write("Full-output characters: " + totalChars + "\n");
            summary.write("Output cap reached: " + capped + "\n");
            summary.write("Target executed: false\n");
        }

        println(
            "apiM decompiled " + completed + "/" + total + " selected functions; " +
            focusedCount + " matched " + String.join(", ", focusTerms) +
            (fallbackBehavior
                ? "; focus miss triggered behavior/API fallback"
                : fallbackFull ? "; focus miss triggered full fallback" : "")
        );
    }
}
