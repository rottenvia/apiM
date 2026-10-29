import PhotosUI
import SwiftUI
import UIKit

/// The chat on the computer's screen, mirrored: what is open there is open here, and the other way round.
struct ChatScreen: View {
    @Environment(Remote.self) private var remote
    @State private var drawer = false
    @State private var settings = false

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                VStack(spacing: 0) {
                    TopBar(openDrawer: { setDrawer(true) }, openSettings: { settings = true })
                    ZStack(alignment: .top) {
                        Conversation()
                        // Words scrolling up fade out under the title instead of being cut at a hard edge.
                        LinearGradient(colors: [Palette.bg, Palette.bg.opacity(0)], startPoint: .top, endPoint: .bottom)
                            .frame(height: 16)
                            .allowsHitTesting(false)
                        VStack(spacing: 8) {
                            if let problem = remote.problem, remote.phase != .online {
                                Banner(icon: "wifi.exclamationmark", text: problem, tint: Palette.warning, action: ("Retry", { remote.connect() }), close: nil)
                            }
                            if let notice = remote.banner {
                                Banner(icon: "exclamationmark.circle", text: notice, tint: Palette.danger, action: nil, close: { remote.banner = nil })
                                    .task(id: notice) {
                                        try? await Task.sleep(nanoseconds: 7_000_000_000)
                                        if remote.banner == notice { remote.banner = nil }
                                    }
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.top, 6)
                        .animation(.easeInOut(duration: 0.25), value: remote.banner)
                        .animation(.easeInOut(duration: 0.25), value: remote.problem)
                    }
                    Composer()
                }
                .background(Palette.bg.ignoresSafeArea())

                if drawer {
                    Color.black.opacity(0.32)
                        .ignoresSafeArea()
                        .onTapGesture { setDrawer(false) }
                        .transition(.opacity)
                    ChatDrawer(close: { setDrawer(false) }, openSettings: {
                        setDrawer(false)
                        settings = true
                    })
                    .frame(width: min(330, geometry.size.width * 0.86))
                    .transition(.move(edge: .leading))
                    // Alongside the list's own scrolling, not instead of it: only a sideways swipe closes.
                    .simultaneousGesture(DragGesture(minimumDistance: 20).onEnded { drag in
                        if drag.translation.width < -60, abs(drag.translation.width) > abs(drag.translation.height) { setDrawer(false) }
                    })
                }
            }
        }
        .sheet(isPresented: $settings) {
            SettingsSheet()
        }
    }

    private func setDrawer(_ open: Bool) {
        if open { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        withAnimation(.spring(response: 0.34, dampingFraction: 0.9)) { drawer = open }
    }
}

private struct TopBar: View {
    @Environment(Remote.self) private var remote
    let openDrawer: () -> Void
    let openSettings: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            IconButton(symbol: "line.3.horizontal", label: "Chats", action: openDrawer)
            Spacer(minLength: 4)
            VStack(spacing: 2) {
                Text(remote.chat.title.isEmpty ? "New chat" : remote.chat.title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Palette.text)
                    .lineLimit(1)
                Button(action: openSettings) {
                    StatusLine()
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("connection")
            }
            Spacer(minLength: 4)
            IconButton(symbol: "square.and.pencil", label: "New chat") {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                remote.newChat()
            }
            .disabled(remote.phase != .online)
        }
        .padding(.horizontal, 8)
        .frame(height: 54)
        .background(Palette.bg)
    }
}

/// "HANNIBAL · Claude Sonnet" with a dot that says whether the link is up.
struct StatusLine: View {
    @Environment(Remote.self) private var remote

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(remote.phase == .online ? Palette.success : Palette.warning)
                .frame(width: 6, height: 6)
            Text(remote.phase == .online ? [remote.name, remote.model].filter { !$0.isEmpty }.joined(separator: " · ") : "Connecting to \(remote.name)…")
                .font(.system(size: 12))
                .foregroundStyle(Palette.text2)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("status")
    }
}

struct IconButton: View {
    let symbol: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Palette.text)
                .frame(width: 42, height: 42)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

struct Banner: View {
    let icon: String
    let text: String
    let tint: Color
    let action: (String, () -> Void)?
    let close: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)
                .padding(.top, 1)
            Text(text)
                .font(.system(size: 13.5))
                .foregroundStyle(Palette.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if let action {
                Button(action.0, action: action.1)
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(Palette.accent)
            }
            if let close {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Palette.text2)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
        }
        .padding(12)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(tint.opacity(0.35), lineWidth: 1))
        .shadow(color: .black.opacity(0.08), radius: 10, y: 3)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}

// MARK: - the transcript

private struct EndKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct Conversation: View {
    @Environment(Remote.self) private var remote
    /// The reader is at the end of the transcript: new words keep it there.
    @State private var follow = true
    /// The transcript and room `follow` was last brought up to date with (`layout`).
    @State private var seen = ""

    var body: some View {
        GeometryReader { outer in
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        if remote.chat.messages.isEmpty && remote.sending == nil {
                            Welcome()
                                .frame(minHeight: outer.size.height - 40)
                        }
                        if remote.chat.earlier > 0 {
                            Text("\(remote.chat.earlier) earlier message\(remote.chat.earlier == 1 ? "" : "s") on \(remote.name)")
                                .font(Typeface.tiny)
                                .foregroundStyle(Palette.muted)
                                .frame(maxWidth: .infinity)
                        }
                        ForEach(remote.chat.messages) { message in
                            MessageRow(message: message, live: isLive(message), status: remote.run.status)
                                .equatable()
                                .id(message.id)
                        }
                        if let sending = remote.sending {
                            UserBubble(message: Message(id: "sending", role: "user", parts: [.text(sending)], at: 0), pending: true)
                        }
                        if let approval = remote.run.approval {
                            ApprovalCard(approval: approval)
                        }
                        if let question = remote.run.question {
                            QuestionCard(question: question)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id("end")
                            .background(GeometryReader { inner in
                                Color.clear.preference(key: EndKey.self, value: inner.frame(in: .named("transcript")).minY)
                            })
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 14)
                    .padding(.bottom, 18)
                }
                .coordinateSpace(name: "transcript")
                .scrollDismissesKeyboard(.interactively)
                .onPreferenceChange(EndKey.self) { y in
                    // Only the reader's own scrolling says whether to follow. The end also moves when the transcript
                    // grows or the keyboard takes room, and taking that as "scrolled away" left an approval card
                    // under the message box: the card arrived, pushed the end off screen, and was not followed.
                    guard layout(outer.size.height) == seen else { return }
                    follow = y < outer.size.height + 60
                }
                .onChange(of: remote.chat.id) { _, _ in
                    follow = true
                    proxy.scrollTo("end", anchor: .bottom)
                }
                .onChange(of: layout(outer.size.height)) { _, now in
                    seen = now
                    if follow { proxy.scrollTo("end", anchor: .bottom) }
                }
                .onChange(of: remote.sending) { _, now in
                    if now != nil {
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("end", anchor: .bottom) }
                    }
                }
                .onAppear {
                    seen = layout(outer.size.height)
                    proxy.scrollTo("end", anchor: .bottom)
                }
                .overlay(alignment: .bottom) {
                    if !follow {
                        Button {
                            withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo("end", anchor: .bottom) }
                        } label: {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Palette.text)
                                .frame(width: 36, height: 36)
                                .background(Palette.elevated, in: Circle())
                                .overlay(Circle().stroke(Palette.border, lineWidth: 1))
                                .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Jump to latest")
                        .padding(.bottom, 10)
                        .transition(.opacity.combined(with: .scale(scale: 0.8)))
                    }
                }
                .animation(.easeInOut(duration: 0.2), value: follow)
            }
        }
    }

    private func isLive(_ message: Message) -> Bool {
        remote.run.running && !message.isUser && message.id == remote.chat.messages.last?.id
    }

    /// The transcript and the room it has: what moves its end without the reader scrolling.
    private func layout(_ height: CGFloat) -> String {
        "\(signature)|\(Int(height))"
    }

    /// Changes whenever the transcript grows: a message added, a reply's words, a step, a card.
    private var signature: String {
        let last = remote.chat.messages.last
        let size = last.map { $0.parts.count * 100_000 + $0.text.count } ?? 0
        return "\(remote.chat.messages.count):\(size):\(remote.run.approval != nil):\(remote.run.question != nil):\(remote.run.running)"
    }
}

private struct Welcome: View {
    @Environment(Remote.self) private var remote

    var body: some View {
        VStack(spacing: 18) {
            Mark(size: 58)
            Text(greeting)
                .font(.system(size: 30, weight: .regular, design: .serif))
                .foregroundStyle(Palette.text)
                .multilineTextAlignment(.center)
            Text(remote.phase == .online ? "Whatever you send here runs in apiM on \(remote.name)." : "Waiting for apiM on \(remote.name)…")
                .font(.system(size: 15))
                .foregroundStyle(Palette.text2)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity)
    }

    private var greeting: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12: return "Good morning"
        case 12..<18: return "Good afternoon"
        default: return "Good evening"
        }
    }
}

// MARK: - cards the reply waits on

private struct ApprovalCard: View {
    @Environment(Remote.self) private var remote
    let approval: Approval

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "hand.raised.fill")
                    .foregroundStyle(Palette.warning)
                Text("apiM wants to run this")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.text)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(approval.command)
                    .font(Typeface.mono)
                    .foregroundStyle(Palette.text)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(12)
            }
            .background(Palette.code, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            if !approval.reason.isEmpty {
                Text(approval.reason)
                    .font(.system(size: 13.5))
                    .foregroundStyle(Palette.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    remote.allow(false)
                } label: {
                    Text("Deny").frame(maxWidth: .infinity)
                }
                .buttonStyle(Secondary())
                Button {
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    remote.allow(true)
                } label: {
                    Text("Allow").frame(maxWidth: .infinity)
                }
                .buttonStyle(Primary())
            }
        }
        .padding(14)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Palette.warning.opacity(0.4), lineWidth: 1))
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

private struct QuestionCard: View {
    @Environment(Remote.self) private var remote
    let question: Question
    @State private var answer = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "questionmark.bubble.fill")
                    .foregroundStyle(Palette.accent)
                Text(question.question)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !question.context.isEmpty {
                Text(question.context)
                    .font(.system(size: 13.5))
                    .foregroundStyle(Palette.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(question.options, id: \.self) { option in
                Button {
                    remote.answer(option)
                } label: {
                    Text(option)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(Secondary(alignment: .leading))
            }
            HStack(spacing: 8) {
                TextField("Your answer", text: $answer, axis: .vertical)
                    .font(.system(size: 15))
                    .lineLimit(1...4)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Palette.bg, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Palette.border, lineWidth: 1))
                Button {
                    remote.answer(answer.trimmingCharacters(in: .whitespacesAndNewlines))
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(Palette.accent, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .opacity(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
                .accessibilityLabel("Answer")
            }
            Button("Skip") { remote.answer("") }
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Palette.text2)
        }
        .padding(14)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Palette.accent.opacity(0.35), lineWidth: 1))
    }
}

struct Primary: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 18)
            .frame(minHeight: 46)
            .background(Palette.accent.opacity(configuration.isPressed ? 0.82 : 1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct Secondary: ButtonStyle {
    var alignment: Alignment = .center

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .medium))
            .foregroundStyle(Palette.text)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 46, alignment: alignment)
            .background(configuration.isPressed ? Palette.hover : Palette.bg, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.border, lineWidth: 1))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// MARK: - the message box

private struct Picked: Identifiable {
    let id = UUID()
    let jpeg: Data
    let thumbnail: UIImage
}

private struct Composer: View {
    @Environment(Remote.self) private var remote
    @State private var draft = ""
    @State private var items: [PhotosPickerItem] = []
    @State private var photos: [Picked] = []
    @FocusState private var focused: Bool

    private var empty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && photos.isEmpty }
    private var online: Bool { remote.phase == .online }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !photos.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(photos) { photo in
                            Image(uiImage: photo.thumbnail)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 58, height: 58)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .overlay(alignment: .topTrailing) {
                                    Button {
                                        photos.removeAll { $0.id == photo.id }
                                    } label: {
                                        Image(systemName: "xmark")
                                            .font(.system(size: 9, weight: .bold))
                                            .foregroundStyle(.white)
                                            .frame(width: 20, height: 20)
                                            .background(Color.black.opacity(0.6), in: Circle())
                                    }
                                    .buttonStyle(.plain)
                                    .padding(4)
                                    .accessibilityLabel("Remove photo")
                                }
                        }
                    }
                }
            }
            TextField(placeholder, text: $draft, axis: .vertical)
                .font(Typeface.body)
                .foregroundStyle(Palette.text)
                .lineLimit(1...7)
                .focused($focused)
                .accessibilityIdentifier("composer")
                .padding(.horizontal, 4)
            HStack(spacing: 10) {
                PhotosPicker(selection: $items, maxSelectionCount: 4, matching: .images) {
                    Image(systemName: "plus")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Palette.text)
                        .frame(width: 34, height: 34)
                        .overlay(Circle().stroke(Palette.border, lineWidth: 1))
                }
                .accessibilityLabel("Add photos")
                Spacer()
                if remote.run.running && empty {
                    Button {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        remote.stop()
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(Palette.bg)
                            .frame(width: 34, height: 34)
                            .background(Palette.text, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Stop")
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 34, height: 34)
                            .background(empty || !online ? Palette.muted.opacity(0.5) : Palette.accent, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(empty || !online)
                    .accessibilityLabel("Send")
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(Palette.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.05), radius: 14, y: 2)
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
        .padding(.top, 2)
        .background(Palette.bg)
        .onChange(of: items) { _, picked in
            guard !picked.isEmpty else { return }
            items = []
            Task { await load(picked) }
        }
    }

    private var placeholder: String {
        if remote.run.running { return "Add to the task…" }
        return remote.chat.messages.isEmpty ? "Message apiM" : "Reply to apiM"
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !photos.isEmpty else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        remote.say(text, photos: photos.map(\.jpeg))
        draft = ""
        photos = []
        // The keyboard goes down so the reply has the screen, as in Claude.
        focused = false
    }

    /// Photos go as JPEGs no longer than 1600 px on a side: what a model reads well, a few hundred KB each.
    private func load(_ picked: [PhotosPickerItem]) async {
        for item in picked {
            guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { continue }
            let scale = min(1, 1600 / max(image.size.width, image.size.height))
            let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            guard let jpeg = resized.jpegData(compressionQuality: 0.8) else { continue }
            let thumb = UIGraphicsImageRenderer(size: CGSize(width: 120, height: 120 * size.height / max(size.width, 1)), format: format).image { context in
                resized.draw(in: context.format.bounds)
            }
            await MainActor.run {
                if photos.count < 4 { photos.append(Picked(jpeg: jpeg, thumbnail: thumb)) }
            }
        }
    }
}
