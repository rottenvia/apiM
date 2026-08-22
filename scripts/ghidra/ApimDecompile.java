// Ghidra headless post-script used by apiM's inspect_binary tool.
//
// This script never runs the imported program. It can either decompile the
// whole program into searchable chunks or first resolve symbols/strings named
// by focus terms and decompile only their referencing functions.
//
// The reference resolver does not trust that auto-analysis already created
// string data types. Headless import on stripped/position-dependent binaries
// can disassemble all of .text yet leave matching feature strings in .rdata
// as raw undefined bytes, so getReferencesTo() returns nothing and the
// function that reads a string can never be located. collectFocused() first
// walks already-defined data, then actively scans initialized memory for
// undefined ASCII/UTF-16 runs containing a focus term, defines them as
// strings, and only then asks the reference manager who points at them.

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.data.DataType;
import ghidra.program.model.data.DataUtilities;
import ghidra.program.model.data.DataUtilities.ClearDataMode;
import ghidra.program.model.data.Undefined;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryAccessException;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.util.CodeUnitInsertionException;

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
import java.util.TreeMap;

public class ApimDecompile extends GhidraScript {
    private static final int CHUNK_CHARS = 350_000;
    private static final int MAX_FUNCTIONS = 100_000;
    private static final int MIN_STRING_LEN = 4;
    private static final int MAX_STRING_LEN = 512;
    // A whole memory block must still be addressable, but it is never read into
    // one array: a 100MB .rdata would otherwise allocate a 100MB byte[] (and
    // often OOM the JVM headlessly on a large client.dll). Scan in fixed
    // windows with an overlap so a term split across a boundary is found.
    private static final long MAX_SCAN_BYTES = 512L * 1024 * 1024;
    private static final int SCAN_WINDOW = 4 * 1024 * 1024;
    // Even so a UTF-16LE string split across windows stays aligned; must be
    // longer than the longest term/string we care about (MAX_STRING_LEN*2).
    private static final int SCAN_OVERLAP = 8192;
    private static final int MAX_STRINGS_DEFINED = 200_000;
    /** Per-function decompile budget, in seconds; override APIM_DECOMPILE_TIMEOUT. */
    private static final int DECOMPILE_TIMEOUT_SECONDS = 300;

    private BufferedWriter chunk;
    private int chunkNumber = 0;
    private int chunkChars = 0;
    private long totalChars = 0;
    private long maxChars;
    private File outputDir;
    private long stringsDefined = 0;
    private long undefinedStringRefs = 0;
    private long disassemblyFallbacks = 0;
    private BufferedWriter indexWriter;
    private BufferedWriter focusIndexWriter;
    private BufferedWriter focusCodeWriter;

    /**
     * Flush every output writer to disk.
     *
     * analyzeHeadless is killed from the outside at the wall-timeout, which
     * aborts the JVM without running finally blocks. BufferedWriters only
     * flush on close, so every function decompiled before the kill used to be
     * lost ("Ghidra died, no output kept"). Flushing after each function means
     * the output already on disk reflects every completed function, turning a
     * timeout into a usable partial result rather than an empty directory.
     */
    private void flushAllOutputs() {
        try { if (indexWriter != null) indexWriter.flush(); } catch (Exception ignored) {}
        try { if (focusIndexWriter != null) focusIndexWriter.flush(); } catch (Exception ignored) {}
        try { if (focusCodeWriter != null) focusCodeWriter.flush(); } catch (Exception ignored) {}
        try { if (chunk != null) chunk.flush(); } catch (Exception ignored) {}
    }

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

    private boolean isScannable(MemoryBlock block) {
        if (block == null) return false;
        if (!block.isInitialized()) return false;
        // Strings relevant to feature names live in initialized data. Skipping
        // executable blocks avoids fighting the disassembler over code bytes.
        if (block.isExecute()) return false;
        if (block.isExternalBlock()) return false;
        // A 0-length or absurdly large block would waste the scan budget.
        long size = block.getSize();
        return size > 0 && size <= MAX_SCAN_BYTES;
    }

    private boolean definedAt(Address address) {
        return currentProgram.getListing().getDataContaining(address) != null
            || currentProgram.getListing().getInstructionContaining(address) != null;
    }

    private static int findTerm(byte[] buffer, int offset, int end, String lowerTerm) {
        int termLength = lowerTerm.length();
        int limit = end - termLength;
        for (int i = offset; i <= limit; i++) {
            boolean hit = true;
            for (int j = 0; j < termLength; j++) {
                int c = buffer[i + j] & 0xff;
                if (c >= 0x80) { hit = false; break; }
                char ch = (char) c;
                if (Character.toLowerCase(ch) != lowerTerm.charAt(j)) { hit = false; break; }
            }
            if (hit) return i;
        }
        return -1;
    }

    private static int findTermUtf16(byte[] buffer, int offset, int end, String lowerTerm) {
        int termLength = lowerTerm.length();
        int limit = end - termLength * 2;
        for (int i = offset; i <= limit; i += 2) {
            boolean hit = true;
            for (int j = 0; j < termLength; j++) {
                int unit = buffer[i + j * 2] & 0xff;
                if (buffer[i + j * 2 + 1] != 0) { hit = false; break; }
                if (unit >= 0x80) { hit = false; break; }
                char ch = (char) unit;
                if (Character.toLowerCase(ch) != lowerTerm.charAt(j)) { hit = false; break; }
            }
            if (hit) return i;
        }
        return -1;
    }

    private int asciiStringStart(byte[] buffer, int hit, int blockStart) {
        int start = hit;
        while (start > blockStart && start - 1 >= 0) {
            int c = buffer[start - 1] & 0xff;
            if (c < 0x20 || c == 0x7f) break;
            start--;
        }
        return start;
    }

    private int asciiStringEnd(byte[] buffer, int hit, int end) {
        int finish = hit;
        int maxEnd = Math.min(end, hit + MAX_STRING_LEN);
        while (finish < maxEnd) {
            int c = buffer[finish] & 0xff;
            if (c < 0x20 || c == 0x7f) break;
            finish++;
        }
        return finish;
    }

    private int utf16StringStart(byte[] buffer, int hit, int blockStart) {
        int start = hit;
        while (start - 2 >= blockStart) {
            int unit = buffer[start - 2] & 0xff;
            if (buffer[start - 1] != 0) break;
            if (unit < 0x20 || unit == 0x7f) break;
            start -= 2;
        }
        return start;
    }

    private int utf16StringEnd(byte[] buffer, int hit, int end) {
        int finish = hit;
        int maxEnd = Math.min(end - 1, hit + MAX_STRING_LEN * 2);
        while (finish + 1 < maxEnd) {
            int unit = buffer[finish] & 0xff;
            if (buffer[finish + 1] != 0) break;
            if (unit < 0x20 || unit == 0x7f) break;
            finish += 2;
        }
        return finish;
    }

    private DataType stringDataType(boolean wide) {
        String preferred = wide ? "wstring" : "string";
        DataType[] found = getDataTypes(preferred);
        if (found != null && found.length > 0 && found[0] != null) return found[0];
        if (wide) {
            // Fall back to the narrow string type; the scan already bounded
            // ASCII runs and a defined char[N] is still a valid xref target.
            DataType[] narrow = getDataTypes("string");
            if (narrow != null && narrow.length > 0 && narrow[0] != null) return narrow[0];
        }
        return null;
    }

    /**
     * Define an undefined string at the candidate address and collect its
     * referencing functions. Returns the address that should carry xrefs
     * (the string start), or null when it could not be defined.
     */
    private Address defineAndReference(
        Address address,
        int length,
        boolean wide,
        Set<String> terms,
        Map<Address, Set<String>> candidates,
        Map<Function, Set<String>> focused
    ) {
        if (length < MIN_STRING_LEN || stringsDefined >= MAX_STRINGS_DEFINED) return null;
        Data existing = currentProgram.getListing().getDataContaining(address);
        boolean alreadyDefined =
            existing != null && !Undefined.isUndefined(existing.getDataType());
        if (!alreadyDefined) {
            Instruction instruction = currentProgram.getListing().getInstructionContaining(address);
            if (instruction != null) return null;
            try {
                DataType type = stringDataType(wide);
                if (type == null) return null;
                Data created = DataUtilities.createData(
                    currentProgram,
                    address,
                    type,
                    0,
                    ClearDataMode.CLEAR_ALL_UNDEFINED_CONFLICT_DATA
                );
                if (created != null) stringsDefined++;
            } catch (CodeUnitInsertionException conflict) {
                // The run overlaps a boundary another definition claimed; the
                // address may still be usable as a reference target.
            } catch (Exception error) {
                printerr("apiM could not define " + (wide ? "wide " : "") + "string at "
                    + address + ": " + error.getMessage());
                return null;
            }
        }
        candidates.put(address, terms);
        // Resolve direct xrefs to the string start immediately. If code instead
        // loads a byte a short way in (sub-string or mid-string LEA on x86),
        // walk a bounded window and attribute those owners too, since that is
        // precisely the reference the defined-data pass missed.
        ReferenceIterator refs = currentProgram.getReferenceManager().getReferencesTo(address);
        boolean hasDirectRef = refs.hasNext();
        while (refs.hasNext()) {
            Reference ref = refs.next();
            Function owner = currentProgram.getFunctionManager()
                .getFunctionContaining(ref.getFromAddress());
            if (owner != null) {
                focused.computeIfAbsent(owner, ignored -> new LinkedHashSet<>()).addAll(terms);
            }
        }
        if (!hasDirectRef) {
            long window = Math.min(length - 1, 64);
            for (long delta = 1; delta <= window; delta++) {
                ReferenceIterator nearby = currentProgram.getReferenceManager()
                    .getReferencesTo(address.add(delta));
                while (nearby.hasNext()) {
                    undefinedStringRefs++;
                    Reference ref = nearby.next();
                    Function owner = currentProgram.getFunctionManager()
                        .getFunctionContaining(ref.getFromAddress());
                    if (owner != null) {
                        focused.computeIfAbsent(owner, ignored -> new LinkedHashSet<>()).addAll(terms);
                    }
                }
            }
        }
        return address;
    }

    /**
     * Search one in-memory window for focus terms and define/attribute any
     * strings found. Window-local offsets are translated to addresses via the
     * supplied base. Runs that start in the overlap region are skipped, so a
     * string that spans two windows is only handled once by the earlier one.
     */
    private void scanWindow(
        byte[] buffer,
        int valid,
        long windowBaseOffset,
        int overlapStart,
        AddressSpace space,
        List<String> terms,
        Map<Address, Set<String>> candidates,
        Map<Function, Set<String>> focused
    ) {
        for (String rawTerm : terms) {
            String term = rawTerm.toLowerCase(Locale.ROOT);
            if (term.length() < 2) continue;

            // ASCII / UTF-8 runs.
            int searchFrom = 0;
            while (searchFrom < valid && !monitor.isCancelled()) {
                int hit = findTerm(buffer, searchFrom, valid, term);
                if (hit < 0) break;
                int start = asciiStringStart(buffer, hit, 0);
                int end = asciiStringEnd(buffer, hit, valid);
                int length = end - start;
                // The match is "owned" by whichever window first contains its
                // string start. A start inside the overlap belongs to the NEXT
                // window (it will see the whole string there); a start before
                // the overlap, including a term that straddles the boundary,
                // is claimed now.
                if (start >= overlapStart) break;
                if (length >= MIN_STRING_LEN) {
                    Address address;
                    try {
                        address = space.getAddress(windowBaseOffset + start);
                    } catch (Exception ignored) {
                        address = null;
                    }
                    if (address != null && !definedAt(address)) {
                        Set<String> termSet = new LinkedHashSet<>();
                        termSet.add(rawTerm);
                        defineAndReference(address, length, false, termSet, candidates, focused);
                    }
                }
                searchFrom = Math.max(hit + term.length(), start + 1);
            }

            // UTF-16LE runs (wide strings on Windows x86-64).
            searchFrom = 0;
            while (searchFrom < valid && !monitor.isCancelled()) {
                int hit = findTermUtf16(buffer, searchFrom, valid, term);
                if (hit < 0) break;
                int start = utf16StringStart(buffer, hit, 0);
                int end = utf16StringEnd(buffer, hit, valid);
                int charLength = (end - start) / 2;
                if (start >= overlapStart) break; // next window owns it
                if (charLength >= MIN_STRING_LEN) {
                    Address address;
                    try {
                        address = space.getAddress(windowBaseOffset + start);
                    } catch (Exception ignored) {
                        address = null;
                    }
                    if (address != null && !definedAt(address)) {
                        Set<String> termSet = new LinkedHashSet<>();
                        termSet.add(rawTerm);
                        defineAndReference(address, charLength, true, termSet, candidates, focused);
                    }
                }
                searchFrom = Math.max(hit + term.length() * 2, start + 2);
            }
        }
    }

    private void scanBlockForTerms(
        MemoryBlock block,
        List<String> terms,
        Map<Address, Set<String>> candidates,
        Map<Function, Set<String>> focused
    ) throws MemoryAccessException {
        long sizeLong = block.getSize();
        if (sizeLong <= 0 || sizeLong > MAX_SCAN_BYTES) return;
        Memory memory = currentProgram.getMemory();
        AddressSpace space = block.getStart().getAddressSpace();
        long baseOffset = block.getStart().getOffset();
        // Read through the program Memory interface in fixed windows: a giant
        // block must not become one giant byte[] on the JVM heap. The trailing
        // overlap keeps term/string matches that straddle a boundary intact.
        byte[] buffer = new byte[SCAN_WINDOW + SCAN_OVERLAP];
        long position = 0;
        while (position < sizeLong && !monitor.isCancelled()) {
            int want = (int) Math.min(buffer.length, sizeLong - position);
            Address at;
            try {
                at = space.getAddress(baseOffset + position);
            } catch (Exception error) {
                printerr("apiM could not address " + block.getName() + "+" + position + ": " + error.getMessage());
                break;
            }
            int read;
            try {
                read = memory.getBytes(at, buffer, 0, want);
            } catch (MemoryAccessException error) {
                // Unmapped/byte-patrolled holes inside a block are non-fatal;
                // skip this window and keep scanning what follows.
                printerr("apiM skipped unreadable window in " + block.getName() + " at " + at + ": " + error.getMessage());
                position += SCAN_WINDOW;
                continue;
            }
            if (read <= 0) {
                position += SCAN_WINDOW;
                continue;
            }
            // Only the first SCAN_WINDOW bytes "own" matches; the tail is
            // overlap, re-handled (and its matches ignored) next time.
            int overlapStart = Math.min(SCAN_WINDOW, read);
            scanWindow(
                buffer,
                read,
                baseOffset + position,
                overlapStart,
                space,
                terms,
                candidates,
                focused
            );
            if (read < want) break; // end of readable block
            position += SCAN_WINDOW;
        }
    }

    /**
     * Scan initialized, non-executable memory for undefined focus-term strings
     * and resolve every discovered candidate's referencing functions.
     */
    private void scanUndefinedStrings(
        List<String> terms,
        Map<Function, Set<String>> focused
    ) {
        if (terms.isEmpty()) return;
        Memory memory = currentProgram.getMemory();
        // Candidates keyed by address so the same string matched by several
        // terms accumulates all of them before xref resolution.
        Map<Address, Set<String>> candidates = new TreeMap<>();

        for (MemoryBlock block : memory.getBlocks()) {
            if (monitor.isCancelled()) return;
            if (!isScannable(block)) continue;
            try {
                scanBlockForTerms(block, terms, candidates, focused);
            } catch (MemoryAccessException error) {
                printerr("apiM could not scan " + block.getName() + ": " + error.getMessage());
            } catch (Exception error) {
                printerr("apiM string scan failed in " + block.getName() + ": " + error.getMessage());
            }
        }

        for (Map.Entry<Address, Set<String>> entry : candidates.entrySet()) {
            if (monitor.isCancelled()) return;
            for (String term : entry.getValue()) {
                addReferenceFunctions(entry.getKey(), term, focused);
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

        // Auto-analysis can leave the very strings the user named as raw
        // undefined bytes in .rdata/.data. Recover them here so the cross
        // reference gap does not hide the function that reads them.
        scanUndefinedStrings(terms, focused);
        return focused;
    }

    private static final int DISASM_INSN_CAP = 4000;

    /**
     * Fallback when the decompiler cannot recover a function: emit its raw
     * instruction listing so the caller can still read the hook (e.g. a
     * CreateMove trampoline) from .text. Bounded both by the function body and
     * an absolute instruction cap so one pathological function cannot flood the
     * output.
     */
    private String disassemble(Function function) {
        StringBuilder out = new StringBuilder();
        AddressSetView body = function.getBody();
        InstructionIterator instructions =
            currentProgram.getListing().getInstructions(body, true);
        int count = 0;
        while (instructions.hasNext() && count < DISASM_INSN_CAP && !monitor.isCancelled()) {
            Instruction insn = instructions.next();
            out.append("  ").append(insn.getMinAddress()).append("  ");
            out.append(insn.toString()).append('\n');
            count++;
        }
        if (count >= DISASM_INSN_CAP) {
            out.append("  ; ... truncated at ").append(DISASM_INSN_CAP)
               .append(" instructions ...\n");
        }
        return out.toString();
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
        String mode = args.length > 1 ? args[1] : "focused";
        boolean focusedOnly = !"full".equalsIgnoreCase(mode);
        boolean allowFullFallback = "focused-fallback".equalsIgnoreCase(mode);
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
            if (work.isEmpty() && allowFullFallback) {
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
             * for bounded full decompilation rather than returning emptiness.
             * Gated: a huge downloaded DLL must not auto-decompile every
             * function just because the chosen focus terms were absent. */
            if (work.isEmpty() && allowFullFallback) {
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

        try {
            indexWriter = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(indexFile), StandardCharsets.UTF_8),
                128 * 1024
            );
            focusIndexWriter = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(focusIndexFile), StandardCharsets.UTF_8),
                128 * 1024
            );
            focusCodeWriter = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(focusCodeFile), StandardCharsets.UTF_8),
                128 * 1024
            );
            final BufferedWriter index = indexWriter;
            final BufferedWriter focusIndex = focusIndexWriter;
            final BufferedWriter focusCode = focusCodeWriter;
            index.write("address\tname\tnamespace\tstatus\tchunk\tsignature\n");
            focusIndex.write("address\tname\tmatched_terms\tsignature\n");
            focusCode.write(
                "/* apiM focused Ghidra decompilation\n" +
                " * Terms: " + String.join(", ", focusTerms) + "\n" +
                " * Target executed: false\n" +
                " * Undefined strings recovered and defined: " + stringsDefined + "\n" +
                " */\n\n"
            );

            for (Function function : work) {
                if (total >= MAX_FUNCTIONS || monitor.isCancelled()) break;
                total++;
                String address = function.getEntryPoint().toString();
                String name = safe(function.getName());
                String namespace = safe(function.getParentNamespace().getName(true));
                String signature = safe(function.getSignature().getPrototypeString());

                // Per-function budget. A single giant routine in a retail
                // game DLL can legitimately take the decompiler minutes; the
                // old 60-120s cap aborted it (and the run) on large files.
                int decompileTimeout = DECOMPILE_TIMEOUT_SECONDS;
                try {
                    String override = System.getenv("APIM_DECOMPILE_TIMEOUT");
                    if (override != null && !override.isBlank()) {
                        decompileTimeout = Math.max(30, Integer.parseInt(override.trim()));
                    }
                } catch (NumberFormatException ignored) { /* keep default */ }
                DecompileResults result = decompiler.decompileFunction(function, decompileTimeout, monitor);
                if (!result.decompileCompleted() || result.getDecompiledFunction() == null) {
                    failed++;
                    index.write(address + "\t" + name + "\t" + namespace + "\tfailed\t\t" + signature + "\n");
                    // The decompiler giving up is not the same as having
                    // nothing. Emit the raw .text listing for any focused
                    // function (and, during full output, every function) so a
                    // hook like CreateMove can still be read instruction by
                    // instruction when C recovery fails.
                    boolean emitDisasm = writeFullOutput || focused.containsKey(function);
                    if (emitDisasm) {
                        String listing = disassemble(function);
                        disassemblyFallbacks++;
                        String error = result.getErrorMessage();
                        String disasmBlock =
                            "/* " + namespace + "::" + name + " @ " + address +
                            " — decompilation failed" +
                            (error == null || error.isBlank() ? "" : ": " + safe(error)) +
                            " */\n" +
                            "/* Raw disassembly fallback:\n" + listing + "*/\n\n";
                        if (writeFullOutput && !capped) {
                            if (!writeFunction(disasmBlock)) capped = true;
                        }
                        if (focused.containsKey(function)) {
                            Set<String> terms = focused.get(function);
                            focusIndex.write(
                                address + "\t" + name + "\t" +
                                String.join(",", terms == null ? Set.of() : terms) +
                                "\t" + signature + "\n"
                            );
                            focusCode.write(
                                "/* Decompilation failed; raw disassembly of " +
                                namespace + "::" + name + " @ " + address + "\n" +
                                " * Matched: " +
                                String.join(", ", terms == null ? Set.of() : terms) +
                                "\n" +
                                (error == null || error.isBlank() ? "" : " * " + safe(error) + "\n") +
                                " */\n" + listing + "\n"
                            );
                            focusedCount++;
                        }
                    }
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

                // Durable against an external SIGKILL at the wall timeout:
                // every completed function (and the chunk it filled) hits disk
                // before the next one starts, so a large binary that times out
                // still leaves everything decompiled so far rather than nothing.
                flushAllOutputs();
            }
            if (focusedCount == 0) {
                focusCode.write(
                    "/* No surviving symbol/string reference matched the requested terms.\n" +
                    " * Undefined strings recovered and defined during the scan: " + stringsDefined + "\n" +
                    (fallbackBehavior
                        ? " * Behavior/API fallback candidates were selected, but none decompiled successfully.\n"
                        : fallbackFull
                            ? " * Full decompilation was generated as a fallback; search those chunks by behavior/API instead.\n"
                            : "") +
                    " */\n"
                );
            }
        } finally {
            // Manual close: these writers are flushed per-function above so a
            // kill at the timeout keeps partial output, and closed here on the
            // normal/aborted path.
            closeChunk();
            try { if (focusCodeWriter != null) focusCodeWriter.close(); } catch (Exception ignored) {}
            try { if (focusIndexWriter != null) focusIndexWriter.close(); } catch (Exception ignored) {}
            try { if (indexWriter != null) indexWriter.close(); } catch (Exception ignored) {}
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
            summary.write("Undefined strings recovered: " + stringsDefined + "\n");
            summary.write("Near-string reference fallbacks: " + undefinedStringRefs + "\n");
            summary.write("Disassembly fallbacks: " + disassemblyFallbacks + "\n");
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
            "; recovered " + stringsDefined + " undefined focus string(s)" +
            (fallbackBehavior
                ? "; focus miss triggered behavior/API fallback"
                : fallbackFull ? "; focus miss triggered full fallback" : "")
        );
    }
}
