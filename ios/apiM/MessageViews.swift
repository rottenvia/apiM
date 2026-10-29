import SwiftUI
import UIKit

/// One message: the user's in a bubble on the right, apiM's as open prose with its thinking and steps in between.
/// Equatable, so the rows a patch did not touch are not drawn again: a reply being written redraws only itself.
struct MessageRow: View, Equatable {
    let message: Message
    /// The reply still being written.
    let live: Bool
    let status: String
    /// The newest message: its reply gets the action bar.
    let last: Bool
    /// A reply is being written in this chat (nothing can be edited, deleted or written again meanwhile).
    let busy: Bool
    let size: CGFloat

    var body: some View {
        if message.isUser {
            if message.note == true {
                NoteChip(text: message.text)
            } else {
                UserBubble(message: message, busy: busy)
            }
        } else {
            AssistantBody(message: message, live: live, status: status, last: last, busy: busy, size: size)
        }
    }
}

private let photoTypes = [".jpg", ".jpeg", ".png", ".heic", ".webp", ".gif"]

struct UserBubble: View {
    let message: Message
    var busy = false
    var pending = false
    @Environment(Remote.self) private var remote
    @Environment(Screen.self) private var screen

    var body: some View {
        let images = message.images ?? []
        // A picture's file is shown as the picture; any other file as a chip.
        let files = (message.files ?? []).filter { name in !images.contains { $0.name == name } }
        HStack {
            Spacer(minLength: 52)
            VStack(alignment: .trailing, spacing: 6) {
                if !images.isEmpty {
                    let side: CGFloat = images.count == 1 ? 200 : 104
                    HStack(spacing: 6) {
                        ForEach(images) { picture in
                            Thumbnail(picture: picture, width: side, height: images.count == 1 ? 150 : 104)
                        }
                    }
                }
                ForEach(files, id: \.self) { name in
                    let photo = photoTypes.contains { name.lowercased().hasSuffix($0) }
                    Label(photo ? "Photo" : name, systemImage: photo ? "photo" : "doc")
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(Palette.text2)
                        .lineLimit(1)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Palette.surface, in: Capsule())
                        .overlay(Capsule().stroke(Palette.border, lineWidth: 1))
                }
                if !message.text.isEmpty {
                    Text(message.text)
                        .font(Typeface.body)
                        .foregroundStyle(Palette.text)
                        .lineSpacing(3)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 10)
                        .background(Palette.userBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        // Held, the bubble lifts on its own: with the pictures it lifted the empty room beside them too.
                        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .contextMenu {
                            if !pending { menu }
                        }
                }
            }
            .contextMenu {
                if message.text.isEmpty && !pending { menu }
            }
        }
        .opacity(pending ? 0.55 : 1)
    }

    @ViewBuilder
    private var menu: some View {
        Button {
            UIPasteboard.general.string = message.text
            Haptics.tap()
        } label: {
            Label("Copy", systemImage: "doc.on.doc")
        }
        Button {
            screen.selecting = Selection(text: message.text)
        } label: {
            Label("Select Text", systemImage: "selection.pin.in.out")
        }
        if !busy && remote.online {
            Button {
                screen.edit(message)
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            Divider()
            Button(role: .destructive) {
                remote.delete(message.id)
            } label: {
                Label("Delete", systemImage: "trash")
            }
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
    let last: Bool
    let busy: Bool
    let size: CGFloat
    @Environment(Remote.self) private var remote
    @Environment(Screen.self) private var screen

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
            VStack(alignment: .leading, spacing: 14) {
                ForEach(segments.indices, id: \.self) { index in
                    switch segments[index] {
                    case .text(let text):
                        MarkdownView(text: text, size: size)
                            .equatable()
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
                        .transition(.opacity)
                }
            }
            .contentShape(.contextMenuPreview, Rectangle())
            .contextMenu { menu }
            if last && !busy && !message.isEmpty && !live {
                ActionBar(message: message)
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var menu: some View {
        if !message.text.isEmpty {
            Button {
                UIPasteboard.general.string = message.text
                Haptics.tap()
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            Button {
                screen.selecting = Selection(text: message.text)
            } label: {
                Label("Select Text", systemImage: "selection.pin.in.out")
            }
        }
        if !busy && remote.online {
            if last {
                Button {
                    Haptics.tap()
                    remote.regenerate()
                } label: {
                    Label("Regenerate", systemImage: "arrow.clockwise")
                }
            }
            Divider()
            Button(role: .destructive) {
                remote.delete(message.id)
            } label: {
                Label("Delete", systemImage: "trash")
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

/// Under the newest reply: copy it, write it again, share it, and which model wrote it.
private struct ActionBar: View {
    let message: Message
    @Environment(Remote.self) private var remote
    @State private var copied = false

    var body: some View {
        HStack(spacing: 2) {
            if !message.text.isEmpty {
                Button {
                    UIPasteboard.general.string = message.text
                    Haptics.tap()
                    withAnimation(.snappy(duration: 0.2)) { copied = true }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { withAnimation(.snappy(duration: 0.2)) { copied = false } }
                } label: {
                    icon(copied ? "checkmark" : "doc.on.doc", tint: copied ? Palette.success : Palette.text2)
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(Press())
                .accessibilityLabel(copied ? "Copied" : "Copy")
            }
            if remote.online {
                Button {
                    Haptics.tap()
                    remote.regenerate()
                } label: {
                    icon("arrow.clockwise", tint: Palette.text2)
                }
                .buttonStyle(Press())
                .accessibilityLabel("Regenerate")
            }
            if !message.text.isEmpty {
                ShareLink(item: message.text) {
                    icon("square.and.arrow.up", tint: Palette.text2)
                }
                .buttonStyle(Press())
                .accessibilityLabel("Share")
            }
            Spacer(minLength: 8)
            if let model = message.model, !model.isEmpty {
                Text(model)
                    .font(.system(size: 11.5))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
            }
        }
        .padding(.leading, -8)
    }

    private func icon(_ name: String, tint: Color) -> some View {
        Image(systemName: name)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: 34, height: 32)
            .contentShape(Rectangle())
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
                Haptics.pick()
                withAnimation(.snappy(duration: 0.25)) { open.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "lightbulb")
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(Palette.text2)
                        .symbolEffect(.pulse, isActive: live && ms == 0)
                    ShimmerText(text: label, active: live && ms == 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Palette.text2)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
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
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .clipped()
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
                    Haptics.pick()
                    withAnimation(.snappy(duration: 0.28)) { all = true }
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
                    .transition(.opacity)
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
        VStack(alignment: .leading, spacing: 8) {
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
                Group {
                    switch tool.ok {
                    case nil:
                        ProgressView()
                            .controlSize(.small)
                    case true?:
                        Image(systemName: "checkmark")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Palette.success)
                            .transition(.scale.combined(with: .opacity))
                    case false?:
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Palette.danger)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .animation(.spring(response: 0.3, dampingFraction: 0.6), value: tool.ok)
                if !tool.summary.isEmpty {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Palette.muted)
                        .rotationEffect(.degrees(open ? 180 : 0))
                }
            }
            if open, !tool.summary.isEmpty {
                Text(tool.summary)
                    .font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(Palette.text2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 32)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
            if !tool.image.isEmpty {
                Thumbnail(picture: Picture(id: tool.image, name: "\(tool.title) \(tool.target)".trimmingCharacters(in: .whitespaces)), height: 180, radius: 10)
                    .padding(.leading, 32)
                    .padding(.bottom, 3)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .contentShape(Rectangle())
        .onTapGesture {
            guard !tool.summary.isEmpty else { return }
            Haptics.pick()
            withAnimation(.snappy(duration: 0.25)) { open.toggle() }
        }
        .clipped()
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
            ShimmerText(text: status.isEmpty ? "Thinking" : status)
                .contentTransition(.opacity)
                .animation(.easeInOut(duration: 0.2), value: status)
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
        .accessibilityHidden(true)
    }
}

/// Text to select a part of: long-press a message, Select Text.
struct Selection: Identifiable {
    let id = UUID()
    let text: String
}

struct SelectSheet: View {
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SelectableText(text: text)
                .background(Palette.bg)
                .navigationTitle("Select Text")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Copy All") {
                            UIPasteboard.general.string = text
                            Haptics.success()
                            dismiss()
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

/// UIKit's text view: SwiftUI's selection takes a whole Text at once, this one a word, a line, any part.
private struct SelectableText: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 16, left: 14, bottom: 24, right: 14)
        view.font = UIFont.systemFont(ofSize: 16)
        view.textColor = UIColor(Palette.text)
        view.adjustsFontForContentSizeCategory = true
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
    }
}
