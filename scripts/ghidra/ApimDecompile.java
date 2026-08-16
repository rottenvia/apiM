// Ghidra headless post-script used by apiM's inspect_binary tool.
//
// This script never runs the imported program. Ghidra has already analysed its
// bytes; the script asks the decompiler for C-like text and writes bounded,
// searchable chunks plus a complete function index.

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;

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
        maxChars = outputCap();

        File indexFile = new File(outputDir, "functions.tsv");
        File summaryFile = new File(outputDir, "summary.txt");
        int total = 0;
        int completed = 0;
        int failed = 0;
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

        try (BufferedWriter index = new BufferedWriter(
            new OutputStreamWriter(new FileOutputStream(indexFile), StandardCharsets.UTF_8),
            128 * 1024
        )) {
            index.write("address\tname\tnamespace\tstatus\tchunk\tsignature\n");
            FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
            while (functions.hasNext() && total < MAX_FUNCTIONS && !monitor.isCancelled()) {
                Function function = functions.next();
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
                String block =
                    "/* " + namespace + "::" + name + " @ " + address + " */\n" +
                    code + "\n\n";
                int destinationChunk = chunkNumber;
                if (chunk == null || chunkChars + block.length() > CHUNK_CHARS) destinationChunk++;
                if (!writeFunction(block)) {
                    capped = true;
                    index.write(address + "\t" + name + "\t" + namespace + "\toutput-cap\t\t" + signature + "\n");
                    break;
                }
                completed++;
                index.write(
                    address + "\t" + name + "\t" + namespace + "\tdecompiled\t" +
                    String.format("decompiled-%04d.c", destinationChunk) + "\t" + signature + "\n"
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
            summary.write("Functions visited: " + total + "\n");
            summary.write("Functions decompiled: " + completed + "\n");
            summary.write("Functions failed: " + failed + "\n");
            summary.write("Chunks: " + chunkNumber + "\n");
            summary.write("Characters written: " + totalChars + "\n");
            summary.write("Output cap reached: " + capped + "\n");
            summary.write("Target executed: false\n");
        }

        println(
            "apiM decompiled " + completed + "/" + total + " functions into " +
            chunkNumber + " chunks" + (capped ? " (output cap reached)" : "")
        );
    }
}
