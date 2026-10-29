import SwiftUI
import UIKit

/// The markdown a model writes, as blocks. Inline marks (bold, italics, `code`, links) are left to Foundation's own
/// parser; this only splits the text into the blocks that parser does not do.
enum Block: Equatable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case list([ListItem])
    case quote(String)
    /// `open` while the closing fence has not arrived yet (the reply is still being written).
    case code(language: String, text: String, open: Bool)
    case table(header: [String], rows: [[String]])
    case rule
}

struct ListItem: Equatable {
    var depth: Int
    /// "•", "3.", "☐" or "☑".
    var marker: String
    var text: String
}

enum Markdown {
    static func blocks(_ source: String) -> [Block] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [Block] = []
        var paragraph: [String] = []
        var items: [ListItem] = []

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph = []
            }
        }
        func flushList() {
            if !items.isEmpty {
                blocks.append(.list(items))
                items = []
            }
        }
        func flush() {
            flushParagraph()
            flushList()
        }

        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                let fence = String(trimmed.prefix(3))
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                var closed = false
                i += 1
                while i < lines.count {
                    if lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                        closed = true
                        i += 1
                        break
                    }
                    code.append(lines[i])
                    i += 1
                }
                blocks.append(.code(language: language, text: code.joined(separator: "\n"), open: !closed))
                continue
            }
            if trimmed.isEmpty {
                flushParagraph()
                // A blank line between items keeps the list going; anything else after it ends the list.
                i += 1
                continue
            }
            if let heading = heading(trimmed) {
                flush()
                blocks.append(heading)
                i += 1
                continue
            }
            if isRule(trimmed) {
                flush()
                blocks.append(.rule)
                i += 1
                continue
            }
            if trimmed.contains("|"), i + 1 < lines.count, isSeparator(lines[i + 1]) {
                flush()
                let header = cells(trimmed)
                var rows: [[String]] = []
                i += 2
                while i < lines.count, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    rows.append(cells(lines[i]))
                    i += 1
                }
                blocks.append(.table(header: header, rows: rows))
                continue
            }
            if let item = listItem(line) {
                flushParagraph()
                items.append(item)
                i += 1
                continue
            }
            if trimmed.hasPrefix(">") {
                flush()
                var quoted: [String] = []
                while i < lines.count {
                    let next = lines[i].trimmingCharacters(in: .whitespaces)
                    guard next.hasPrefix(">") else { break }
                    quoted.append(String(next.dropFirst()).trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                blocks.append(.quote(quoted.joined(separator: "\n")))
                continue
            }
            // A line under an item, indented or not, before any blank line: the item goes on.
            if paragraph.isEmpty, !items.isEmpty, lines[i - 1].trimmingCharacters(in: .whitespaces).isEmpty == false {
                items[items.count - 1].text += "\n" + trimmed
                i += 1
                continue
            }
            flushList()
            paragraph.append(trimmed)
            i += 1
        }
        flush()
        return blocks
    }

    private static func heading(_ line: String) -> Block? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), line.count > hashes, line[line.index(line.startIndex, offsetBy: hashes)] == " " else { return nil }
        var text = String(line.dropFirst(hashes)).trimmingCharacters(in: .whitespaces)
        while text.hasSuffix("#") { text.removeLast() }
        return .heading(level: hashes, text: text.trimmingCharacters(in: .whitespaces))
    }

    private static func isRule(_ line: String) -> Bool {
        let bare = line.replacingOccurrences(of: " ", with: "")
        guard bare.count >= 3, let first = bare.first, "-*_".contains(first) else { return false }
        return bare.allSatisfy { $0 == first }
    }

    private static func isSeparator(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.contains("-") && trimmed.contains("|") && trimmed.allSatisfy { "|:- ".contains($0) }
    }

    static func cells(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") { trimmed.removeLast() }
        return trimmed.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func listItem(_ line: String) -> ListItem? {
        let indent = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
        let rest = line.drop { $0 == " " || $0 == "\t" }
        let depth = min(indent / 2, 4)
        for bullet in ["- ", "* ", "+ "] where rest.hasPrefix(bullet) {
            let text = String(rest.dropFirst(2))
            if text.hasPrefix("[ ] ") { return ListItem(depth: depth, marker: "☐", text: String(text.dropFirst(4))) }
            if text.lowercased().hasPrefix("[x] ") { return ListItem(depth: depth, marker: "☑", text: String(text.dropFirst(4))) }
            return ListItem(depth: depth, marker: "•", text: text)
        }
        let digits = rest.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count <= 3 else { return nil }
        let after = rest.dropFirst(digits.count)
        guard after.hasPrefix(". ") || after.hasPrefix(") ") else { return nil }
        return ListItem(depth: depth, marker: String(digits) + ".", text: String(after.dropFirst(2)))
    }

    /// Bold, italics, links and inline code, with code set in mono on a tint.
    static func inline(_ text: String, size: CGFloat) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        var styled = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        for run in styled.runs {
            guard let intent = run.inlinePresentationIntent, intent.contains(.code) else { continue }
            styled[run.range].font = .system(size: size - 2, design: .monospaced)
            styled[run.range].backgroundColor = Palette.code
            styled[run.range].foregroundColor = Palette.accent
        }
        return styled
    }
}

/// A model's answer, block by block.
struct MarkdownView: View, Equatable {
    let text: String
    var size: CGFloat = Typeface.proseSize

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(Markdown.blocks(text).enumerated()), id: \.offset) { _, block in
                BlockView(block: block, size: size)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct BlockView: View {
    static let headings: [CGFloat] = [0, 24, 21, 19, 17.5, 17, 17]
    let block: Block
    let size: CGFloat

    var body: some View {
        switch block {
        case .paragraph(let text):
            prose(text)
        case .heading(let level, let text):
            Text(Markdown.inline(text, size: size))
                .font(.system(size: BlockView.headings[min(level, 6)], weight: .semibold, design: .serif))
                .foregroundStyle(Palette.text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, level <= 2 ? 6 : 2)
        case .list(let items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 9) {
                        Text(item.marker)
                            .font(.system(size: item.marker == "•" ? size : size - 1, weight: .medium, design: .serif))
                            .foregroundStyle(Palette.text2)
                            .frame(minWidth: 14, alignment: .trailing)
                        prose(item.text)
                    }
                    .padding(.leading, CGFloat(item.depth) * 18)
                }
            }
        case .quote(let text):
            HStack(alignment: .top, spacing: 12) {
                RoundedRectangle(cornerRadius: 1.5).fill(Palette.borderStrong).frame(width: 3)
                prose(text).foregroundStyle(Palette.text2)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let text, _):
            CodeBlock(language: language, code: text)
        case .table(let header, let rows):
            TableBlock(header: header, rows: rows, size: size)
        case .rule:
            Rectangle().fill(Palette.border).frame(height: 1).padding(.vertical, 4)
        }
    }

    private func prose(_ text: String) -> some View {
        Text(Markdown.inline(text, size: size))
            .font(.system(size: size, design: .serif))
            .foregroundStyle(Palette.text)
            .lineSpacing(size * 0.28)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }
}

struct CodeBlock: View {
    let language: String
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Palette.text2)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { copied = false }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(copied ? Palette.success : Palette.text2)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            Rectangle().fill(Palette.border).frame(height: 1)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code.isEmpty ? " " : code)
                    .font(Typeface.mono)
                    .foregroundStyle(Palette.text)
                    .lineSpacing(3)
                    .fixedSize(horizontal: true, vertical: true)
                    .textSelection(.enabled)
                    .padding(12)
            }
        }
        .background(Palette.code, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Palette.border, lineWidth: 1))
    }
}

private struct TableBlock: View {
    let header: [String]
    let rows: [[String]]
    let size: CGFloat

    var body: some View {
        let columns = max(header.count, rows.map(\.count).max() ?? 0)
        // Up to three columns wrap to the screen's width; more scroll sideways, as they would never fit.
        if columns <= 3 {
            grid(columns, wrap: true)
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                grid(columns, wrap: false)
            }
        }
    }

    private func grid(_ columns: Int, wrap: Bool) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(0..<columns, id: \.self) { c in
                    cell(c < header.count ? header[c] : "", bold: true, wrap: wrap)
                }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                Rectangle().fill(Palette.border).frame(height: 1).gridCellColumns(columns)
                GridRow {
                    ForEach(0..<columns, id: \.self) { c in
                        cell(c < row.count ? row[c] : "", bold: false, wrap: wrap)
                    }
                }
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func cell(_ text: String, bold: Bool, wrap: Bool) -> some View {
        Text(Markdown.inline(text, size: size - 2))
            .font(.system(size: size - 2, weight: bold ? .semibold : .regular))
            .foregroundStyle(Palette.text)
            .frame(minWidth: wrap ? 0 : 70, maxWidth: wrap ? .infinity : 260, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(bold ? Palette.hover.opacity(0.6) : Color.clear)
    }
}
