import SwiftUI
import UIKit

/// One message: the user's in a bubble on the right, apiM's as open prose with its thinking and steps in between.
struct MessageRow: View, Equatable {
    let message: Message
    /// The reply still being written.
    let live: Bool
    let status: String

    var body: some View {
        if message.isUser {
            if message.note == true {
                NoteChip(text: message.text)
            } else {
                UserBubble(message: message)
            }
        } else {
            AssistantBody(message: message, live: live, status: status)
        }
    }
}

struct UserBubble: View {
    let message: Message
    var pending = false

    var body: some View {
        HStack {
            Spacer(minLength: 52)
            VStack(alignment: .trailing, spacing: 6) {
                if let files = message.files, !files.isEmpty {
                    ForEach(files, id: \.self) { name in
                        // A photo's file name is one the computer made up; what it is says more.
                        let photo = [".jpg", ".jpeg", ".png", ".heic", ".webp", ".gif"].contains { name.lowercased().hasSuffix($0) }
                        Label(photo ? "Photo" : name, systemImage: photo ? "photo" : "doc")
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(Palette.text2)
                            .lineLimit(1)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Palette.surface, in: Capsule())
                            .overlay(Capsule().stroke(Palette.border, lineWidth: 1))
                    }
                }
                if !message.text.isEmpty {
                    Text(message.text)
                        .font(Typeface.body)
                        .foregroundStyle(Palette.text)
                        .lineSpacing(3)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 10)
                        .background(Palette.userBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .textSelection(.enabled)
                }
            }
        }
        .opacity(pending ? 0.55 : 1)
        .contextMenu {
            Button { UIPasteboard.general.string = message.text } label: { Label("Copy", systemImage: "doc.on.doc") }
        }
    }
}

/// A "btw" note added while a reply ran.
struct NoteChip: View {
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrowshape.turn.up.right")
                .font(.system(size: 11, weight: .semibold))
            Text(text)
                .font(.system(size: 13))
                .lineLimit(3)
        }
        .foregroundStyle(Palette.text2)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Palette.hover.opacity(0.7), in: Capsule())
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// A reply reads top to bottom: each stretch of prose, then the steps it led to.
struct AssistantBody: View {
    let message: Message
    let live: Bool
    let status: String

    private enum Segment {
        case text(String)
        case think(String, Double)
        case steps([Tool])
        case notice(String)
    }

    private var segments: [Segment] {
        var out: [Segment] = []
        for piece in message.parts {
            switch piece {
            case .text(let text):
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
                if case .text(let before) = out.last {
                    out[out.count - 1] = .text(before + text)
                } else {
                    out.append(.text(text))
                }
            case .think(let text, let ms):
                out.append(.think(text, ms))
            case .tool(let tool):
                if case .steps(let before) = out.last {
                    out[out.count - 1] = .steps(before + [tool])
                } else {
                    out.append(.steps([tool]))
                }
            case .notice(let text):
                out.append(.notice(text))
            }
        }
        return out
    }

    var body: some View {
        let segments = self.segments
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(segments.enumerated()), id: \.offset) { index, segment in
                switch segment {
                case .text(let text):
                    MarkdownView(text: text)
                case .think(let text, let ms):
                    ThoughtRow(text: text, ms: ms, live: live && index == segments.count - 1)
                case .steps(let tools):
                    StepsBox(tools: tools)
                case .notice(let text):
                    Text(text)
                        .font(.system(size: 13))
                        .italic()
                        .foregroundStyle(Palette.muted)
                }
            }
            if let error = message.error, !error.isEmpty {
                ErrorCard(text: error)
            }
            if live, segments.isEmpty || !isWriting(segments.last) {
                Working(status: status)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            if !message.text.isEmpty {
                Button { UIPasteboard.general.string = message.text } label: { Label("Copy", systemImage: "doc.on.doc") }
            }
        }
    }

    /// The last thing in the reply already moves on its own: prose being typed, a thought or a step running.
    private func isWriting(_ segment: Segment?) -> Bool {
        guard let segment else { return false }
        switch segment {
        case .text: return true
        case .think(_, let ms): return ms == 0
        case .steps(let tools): return tools.last?.ok == nil
        default: return false
        }
    }
}

/// "Thinking" while it thinks, "Thought for 12s" after; opens to show the thought.
struct ThoughtRow: View {
    let text: String
    let ms: Double
    let live: Bool
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "lightbulb")
                        .font(.system(size: 12.5, weight: .medium))
                    Text(label)
                        .font(.system(size: 14, weight: .medium))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .foregroundStyle(Palette.text2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                Text(text.isEmpty ? "…" : text)
                    .font(.system(size: 14))
                    .foregroundStyle(Palette.text2)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(Palette.border).frame(width: 2)
                    }
                    .textSelection(.enabled)
                    .transition(.opacity)
            }
        }
    }

    private var label: String {
        if ms == 0 { return live ? "Thinking" : "Thought" }
        let seconds = Int((ms / 1000).rounded())
        return seconds < 1 ? "Thought briefly" : seconds < 60 ? "Thought for \(seconds)s" : "Thought for \(seconds / 60)m \(seconds % 60)s"
    }
}

/// The steps between two stretches of prose, in one box. A long run shows its last few, the rest one tap away.
struct StepsBox: View {
    let tools: [Tool]
    @State private var all = false
    private let shown = 4

    var body: some View {
        let hidden = all ? 0 : max(0, tools.count - shown)
        VStack(alignment: .leading, spacing: 0) {
            if hidden > 0 {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { all = true }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "ellipsis")
                            .frame(width: 22)
                        Text("\(hidden) earlier step\(hidden == 1 ? "" : "s")")
                        Spacer()
                    }
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Palette.text2)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Rectangle().fill(Palette.border).frame(height: 1)
            }
            ForEach(Array(tools.dropFirst(hidden).enumerated()), id: \.offset) { index, tool in
                if index > 0 {
                    Rectangle().fill(Palette.border).frame(height: 1).padding(.leading, 44)
                }
                StepRow(tool: tool)
            }
        }
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.border, lineWidth: 1))
    }
}

struct StepRow: View {
    let tool: Tool
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: StepRow.symbol(tool.kind))
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Palette.text2)
                    .frame(width: 22, height: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(tool.title)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                    if !tool.target.isEmpty {
                        Text(tool.target)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Palette.text2)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                switch tool.ok {
                case nil:
                    ProgressView()
                        .controlSize(.small)
                case true?:
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Palette.success)
                case false?:
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Palette.danger)
                }
            }
            if open, !tool.summary.isEmpty {
                Text(tool.summary)
                    .font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(Palette.text2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 32)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .contentShape(Rectangle())
        .onTapGesture {
            guard !tool.summary.isEmpty else { return }
            withAnimation(.easeInOut(duration: 0.18)) { open.toggle() }
        }
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "read": return "doc.text"
        case "write": return "square.and.pencil"
        case "delete": return "trash"
        case "search": return "magnifyingglass"
        case "run": return "terminal"
        case "web": return "globe"
        case "plan": return "list.bullet.clipboard"
        case "git": return "arrow.triangle.branch"
        case "note": return "bookmark"
        case "ask": return "questionmark.bubble"
        case "image": return "photo"
        case "computer": return "desktopcomputer"
        case "done": return "checkmark.seal"
        default: return "wrench.and.screwdriver"
        }
    }
}

struct ErrorCard: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14))
                .foregroundStyle(Palette.danger)
            Text(text)
                .font(.system(size: 14))
                .foregroundStyle(Palette.text)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Palette.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Palette.danger.opacity(0.28), lineWidth: 1))
    }
}

/// What a reply that has not said anything yet is doing.
struct Working: View {
    let status: String

    var body: some View {
        HStack(spacing: 10) {
            Dots()
            Text(status.isEmpty ? "Thinking" : status)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Palette.text2)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Three dots in the accent colour, rising one after another.
struct Dots: View {
    var size: CGFloat = 6

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: size * 0.7) {
                ForEach(0..<3, id: \.self) { i in
                    let wave = max(0, sin(t * 5 - Double(i) * 0.8))
                    Circle()
                        .fill(Palette.accent)
                        .frame(width: size, height: size)
                        .opacity(0.35 + 0.65 * wave)
                        .offset(y: -size * 0.45 * wave)
                }
            }
            .frame(height: size * 2)
        }
    }
}
