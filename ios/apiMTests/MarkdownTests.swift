import XCTest
@testable import apiM

final class MarkdownTests: XCTestCase {
    func testBlocks() {
        let text = """
        # Title
        Some **bold** words
        on two lines.

        - one
        - two
          more of two
        1. first
        2. second

        ```swift
        let x = 1
        ```

        | A | B |
        |---|:-:|
        | 1 | 2 |

        > quoted
        ---
        """
        let blocks = Markdown.blocks(text)
        XCTAssertEqual(blocks.count, 7, "\(blocks)")
        XCTAssertEqual(blocks[0], .heading(level: 1, text: "Title"))
        XCTAssertEqual(blocks[1], .paragraph("Some **bold** words\non two lines."))
        XCTAssertEqual(blocks[2], .list([
            ListItem(depth: 0, marker: "•", text: "one"),
            ListItem(depth: 0, marker: "•", text: "two\nmore of two"),
            ListItem(depth: 0, marker: "1.", text: "first"),
            ListItem(depth: 0, marker: "2.", text: "second"),
        ]))
        XCTAssertEqual(blocks[3], .code(language: "swift", text: "let x = 1", open: false))
        XCTAssertEqual(blocks[4], .table(header: ["A", "B"], rows: [["1", "2"]]))
        XCTAssertEqual(blocks[5], .quote("quoted"))
        XCTAssertEqual(blocks[6], .rule)
    }

    func testACodeBlockStillBeingWritten() {
        XCTAssertEqual(Markdown.blocks("Here:\n```py\nprint(1)"), [.paragraph("Here:"), .code(language: "py", text: "print(1)", open: true)])
    }

    /// Laid out once: the same text comes back from the cache, and a block above the one being written is not
    /// styled again.
    func testProseIsKept() {
        let text = "First **bold** paragraph.\n\nSecond, being written"
        let first = Prose.render(text, size: 17)
        XCTAssertEqual(first.count, 2)
        guard case .paragraph(let bold) = first[0] else { return XCTFail("a paragraph") }
        XCTAssertTrue(bold.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }, "bold kept its mark")
        let more = Prose.render(text + " more", size: 17)
        guard case .paragraph(let again) = more[0] else { return XCTFail("a paragraph") }
        XCTAssertEqual(again, bold)
        XCTAssertEqual(Prose.words("First **bold** paragraph.", size: 17), bold)
    }

    func testNotAHeadingNotAList() {
        XCTAssertEqual(Markdown.blocks("#hashtag and 2024.5 is a year-ish"), [.paragraph("#hashtag and 2024.5 is a year-ish")])
    }
}
