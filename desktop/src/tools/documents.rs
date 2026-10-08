//! The `read_document` tool (the `read_document` case of src/lib/tools.ts): the text of a .docx, .xlsx, .pptx, .epub, .odt
//! or .pdf in the workspace. The path goes through `resolve` like every other path from the model.

use super::code::{bad, inside, suggest_paths};
use super::{Output, str_arg};
use crate::media::documents::{MAX_DOC_CHARS, document_kind, read_document as read};
use crate::media::js_trim;
use serde_json::Value;
use std::path::Path;

/// The tool with the web's default character budget.
pub fn read_document(root: &Path, args: &Value) -> Output {
    read_document_limited(root, args, MAX_DOC_CHARS)
}

/// The tool with a character budget sized to the model's context window (`ctx.limits.doc_chars`).
pub fn read_document_limited(root: &Path, args: &Value, max_chars: usize) -> Output {
    let target = str_arg(args, "path");
    let Some(kind) = document_kind(target) else {
        return bad(format!("{target} is not a document this can open. It handles .docx, .xlsx, .pptx, .epub and .odt — for anything text-based use read_file."), "Not a document");
    };
    // The web's `readFileBytes` and its error texts; a thrown message is reported as "Error: <message>".
    // A wrong path comes back with the nearest real ones, as the web's catch-all does for any "No such file".
    let fail = |message: String| {
        let hint = if message.starts_with("No such file") { suggest_paths(root, target) } else { String::new() };
        bad(if hint.is_empty() { format!("Error: {message}") } else { format!("Error: {message}\n\n{hint}") }, message)
    };
    let bytes = match inside(root, target).and_then(|path| {
        let meta = std::fs::metadata(&path).map_err(|_| format!("No such file: {target}"))?;
        if !meta.is_file() {
            return Err(format!("{target} is not a file"));
        }
        if meta.len() > 512 * 1024 * 1024 {
            return Err(format!("{target} is too large to read"));
        }
        std::fs::read(&path).map_err(|e| format!("Cannot read {target}: {e}"))
    }) {
        Ok(bytes) => bytes,
        Err(message) => return fail(message),
    };
    let doc = match read(kind, &bytes, max_chars) {
        Ok(doc) => doc,
        Err(message) => return fail(message),
    };
    if js_trim(&doc.text).is_empty() {
        return bad(format!("{target} opened but contained no readable text."), format!("Empty document: {target}"));
    }
    Output::ok(format!("{target} ({}{}):\n\n{}", kind.as_str(), if doc.truncated { ", truncated" } else { "" }, doc.text), format!("Read {target}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::test_zip;
    use serde_json::json;

    #[test]
    fn reads_a_document_and_reports_the_webs_errors() {
        let dir = std::env::temp_dir().join(format!("apim-readdoc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/a.docx"), test_zip(&[("word/document.xml", b"<w:p><w:t>Hello world</w:t></w:p>")])).unwrap();
        std::fs::write(dir.join("empty.docx"), test_zip(&[("word/document.xml", b"<w:p></w:p>")])).unwrap();
        std::fs::write(dir.join("bad.pptx"), b"nope").unwrap();
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        let run = |path: &str| read_document(&dir, &json!({ "path": path }));
        let ok = run("sub/a.docx");
        assert_eq!((ok.ok, ok.text.as_str(), ok.summary.as_str()), (true, "sub/a.docx (docx):\n\nHello world", "Read sub/a.docx"));
        let cut = read_document_limited(&dir, &json!({ "path": "sub/a.docx" }), 5);
        assert_eq!(cut.text, "sub/a.docx (docx, truncated):\n\nHello");
        let wrong = run("a.txt");
        assert_eq!((wrong.ok, wrong.text.as_str(), wrong.summary.as_str()), (false, "a.txt is not a document this can open. It handles .docx, .xlsx, .pptx, .epub and .odt — for anything text-based use read_file.", "Not a document"));
        let empty = run("empty.docx");
        assert_eq!((empty.text.as_str(), empty.summary.as_str()), ("empty.docx opened but contained no readable text.", "Empty document: empty.docx"));
        let broken = run("bad.pptx");
        assert_eq!((broken.text.as_str(), broken.summary.as_str()), ("Error: Not a valid .zip file", "Not a valid .zip file"));
        // a missing file gets the nearest real paths appended, like the web's catch-all
        assert!(run("gone.docx").text.starts_with("Error: No such file: gone.docx

"));
        let near = run("sup/a.docx");
        assert!(near.text.starts_with("Error: No such file: sup/a.docx

") && near.text.contains("sub/a.docx") && near.summary == "No such file: sup/a.docx");
        assert_eq!(run("sub").text, "sub is not a document this can open. It handles .docx, .xlsx, .pptx, .epub and .odt — for anything text-based use read_file.");
        assert_eq!(run("../outside.docx").text.starts_with("Error: Path escapes the workspace"), true);
        assert!(run("x.pdf").text.contains("Error: No such file: x.pdf"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
