import SwiftUI
import UIKit

/// What the screen has open over the chat: the drawer's dialogs, the sheets, the picture viewer, a message being
/// edited. Kept apart from `Remote`, which is only what the computer said.
@Observable
final class Screen {
    var settings = false
    var models = false
    var effort = false
    var viewer: Picture?
    var selecting: Selection?
    var renaming: ChatRow?
    var deleting: ChatRow?
    /// The question being asked again in other words, in the message box.
    var editing: Message?

    func edit(_ message: Message) {
        Haptics.tap()
        withAnimation(.snappy(duration: 0.25)) { editing = message }
    }
}

/// The chat on the computer's screen, mirrored: what is open there is open here, and the other way round. Swipe
/// right from the left half of the screen for the chats.
struct ChatScreen: View {
    @Environment(Remote.self) private var remote
    @Environment(Screen.self) private var screen
    @Namespace private var zoom
    /// 0 closed, 1 open; follows the finger while the drawer is dragged.
    @State private var drawer: CGFloat = 0
    /// Still on screen while it slides away; taken out once it is gone, so a closed drawer draws nothing (its rows'
    /// dots for running chats would otherwise animate unseen, and the app would never be idle).
    @State private var drawerShown = false
    @State private var title = ""
    @AppStorage("textSize") private var textSize = 1

    var body: some View {
        GeometryReader { geometry in
            let width = min(330, geometry.size.width * 0.84)
            ZStack(alignment: .leading) {
                VStack(spacing: 0) {
                    TopBar(openDrawer: { setDrawer(true) })
                    ZStack(alignment: .top) {
                        Transcript(size: Typeface.proseSize)
                            .id(remote.chat.id)
                            .transition(.opacity)
                        // Words scrolling up fade out under the title instead of being cut at a hard edge.
                        LinearGradient(colors: [Palette.bg, Palette.bg.opacity(0)], startPoint: .top, endPoint: .bottom)
                            .frame(height: 16)
                            .allowsHitTesting(false)
                        Banners()
                    }
                    Composer()
                }
                .background(Palette.bg.ignoresSafeArea())
                .offset(x: drawer * width * 0.18)

                if drawerShown {
                    Color.black.opacity(0.36 * drawer)
                        .ignoresSafeArea()
                        .onTapGesture { setDrawer(false) }
                        .transition(.identity)
                    ChatDrawer(close: { setDrawer(false) })
                        .frame(width: width)
                        // The shadow is the panel's own, behind it: on the drawer itself it fell on every row.
                        .background {
                            Rectangle()
                                .fill(Palette.bg2)
                                .shadow(color: .black.opacity(0.18 * drawer), radius: 18, x: 4)
                                .ignoresSafeArea()
                        }
                        .offset(x: (drawer - 1) * (width + 24))
                        .transition(.identity)
                }
            }
            .background {
                DrawerPan(open: drawer > 0.5, width: width, moved: { progress in
                    if drawer == 0 { hideKeyboard() }
                    drawerShown = true
                    drawer = progress
                }, ended: { open in
                    setDrawer(open)
                })
            }
        }
        .environment(\.zoomSpace, zoom)
        .sheet(isPresented: Bindable(screen).settings) {
            SettingsView()
        }
        .sheet(isPresented: Bindable(screen).models) {
            ModelSheet()
        }
        .sheet(isPresented: Bindable(screen).effort) {
            EffortSheet()
        }
        .sheet(item: Bindable(screen).selecting) { selection in
            SelectSheet(text: selection.text)
        }
        .fullScreenCover(item: Bindable(screen).viewer) { picture in
            ImageViewer(picture: picture)
                .navigationTransition(.zoom(sourceID: picture.id, in: zoom))
        }
        .alert("Rename chat", isPresented: Binding(get: { screen.renaming != nil }, set: { if !$0 { screen.renaming = nil } })) {
            TextField("Title", text: $title)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                if let row = screen.renaming { remote.rename(row.id, title) }
            }
        } message: {
            Text("The new name shows on \(remote.name) too.")
        }
        .onChange(of: screen.renaming) { _, row in
            if let row { title = row.title }
        }
        .confirmationDialog("Delete this chat?", isPresented: Binding(get: { screen.deleting != nil }, set: { if !$0 { screen.deleting = nil } }), titleVisibility: .visible, presenting: screen.deleting) { row in
            Button("Delete", role: .destructive) {
                Haptics.press()
                remote.deleteChat(row.id)
            }
        } message: { row in
            Text("\u{201c}\(row.title.isEmpty ? "Untitled" : row.title)\u{201d} is deleted on \(remote.name) too. This can't be undone.")
        }
    }

    private func setDrawer(_ open: Bool) {
        hideKeyboard()
        if open != (drawer > 0.5) { Haptics.tap() }
        if open { drawerShown = true }
        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
            drawer = open ? 1 : 0
        } completion: {
            if drawer == 0 { drawerShown = false }
        }
    }

    private func hideKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

/// The drawer's swipe. A UIKit pan on the window's root view, which sheets and the viewer are not under: it begins
/// only for a sideways drag (rightwards from the left half of the screen to open, leftwards to close), so the
/// transcript's own scrolling and a code block's sideways scrolling keep their drags.
private struct DrawerPan: UIViewRepresentable {
    var open: Bool
    var width: CGFloat
    var moved: (CGFloat) -> Void
    var ended: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> Anchor {
        let view = Anchor()
        view.coordinator = context.coordinator
        view.isUserInteractionEnabled = false
        context.coordinator.pan = view.pan
        return view
    }

    func updateUIView(_ view: Anchor, context: Context) {
        context.coordinator.drawer = self
    }

    static func dismantleUIView(_ view: Anchor, coordinator: Coordinator) {
        view.pan.view?.removeGestureRecognizer(view.pan)
    }

    final class Anchor: UIView {
        weak var coordinator: Coordinator?
        lazy var pan: UIPanGestureRecognizer = {
            let pan = UIPanGestureRecognizer(target: nil, action: nil)
            pan.maximumNumberOfTouches = 1
            return pan
        }()

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let window, let coordinator, pan.view == nil else { return }
            pan.addTarget(coordinator, action: #selector(Coordinator.panned(_:)))
            pan.delegate = coordinator
            (window.rootViewController?.view ?? window).addGestureRecognizer(pan)
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var drawer: DrawerPan?
        weak var pan: UIPanGestureRecognizer?
        private var from: CGFloat = 0

        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard let drawer, let pan = gesture as? UIPanGestureRecognizer, let view = pan.view else { return false }
            let velocity = pan.velocity(in: view)
            guard abs(velocity.x) > abs(velocity.y) * 1.4 else { return false }
            let at = pan.location(in: view)
            let moved = pan.translation(in: view)
            let start = CGPoint(x: at.x - moved.x, y: at.y - moved.y)
            if drawer.open {
                guard velocity.x < 0 else { return false }
                // Begun on a chat in the list, it is that row's swipe (archive, delete), not the drawer's.
                if start.x < drawer.width {
                    var hit = view.hitTest(start, with: nil)
                    while let current = hit {
                        if current is UICollectionViewCell { return false }
                        hit = current.superview
                    }
                }
                return true
            }
            return velocity.x > 0 && start.x < view.bounds.width * 0.5
        }

        @objc func panned(_ pan: UIPanGestureRecognizer) {
            guard let drawer, let view = pan.view else { return }
            let dx = pan.translation(in: view).x
            let progress = min(1, max(0, from + dx / max(drawer.width, 1)))
            switch pan.state {
            case .began:
                from = drawer.open ? 1 : 0
            case .changed:
                drawer.moved(progress)
            case .ended:
                let speed = pan.velocity(in: view).x
                drawer.ended(abs(speed) > 450 ? speed > 0 : progress > 0.5)
            case .cancelled, .failed:
                drawer.ended(drawer.open)
            default:
                break
            }
        }
    }
}

private struct TopBar: View {
    @Environment(Remote.self) private var remote
    @Environment(Screen.self) private var screen
    let openDrawer: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            IconButton(symbol: "line.3.horizontal", label: "Chats", action: openDrawer)
            Spacer(minLength: 4)
            VStack(spacing: 2) {
                titleMenu
                Button {
                    screen.settings = true
                } label: {
                    StatusLine()
                }
                .buttonStyle(Press(scale: 0.96))
                .accessibilityIdentifier("connection")
            }
            Spacer(minLength: 4)
            IconButton(symbol: "square.and.pencil", label: "New chat") {
                Haptics.tap()
                remote.newChat()
            }
            .disabled(!remote.online)
        }
        .padding(.horizontal, 8)
        .frame(height: 54)
        .background(Palette.bg)
    }

    /// The chat's name; tapped, what can be done to the chat.
    @ViewBuilder
    private var titleMenu: some View {
        let title = Text(remote.chat.title.isEmpty ? "New chat" : remote.chat.title)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(Palette.text)
            .lineLimit(1)
            .contentTransition(.opacity)
        if let row = remote.chats.first(where: { $0.id == remote.chat.id }), remote.online {
            Menu {
                Button {
                    screen.renaming = row
                } label: {
                    Label("Rename", systemImage: "pencil")
                }
                Button {
                    remote.archive(row.id, !row.isArchived)
                } label: {
                    Label(row.isArchived ? "Unarchive" : "Archive", systemImage: "archivebox")
                }
                Divider()
                Button(role: .destructive) {
                    screen.deleting = row
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            } label: {
                HStack(spacing: 4) {
                    title
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Palette.muted)
                }
            }
            .accessibilityIdentifier("chat-title")
        } else {
            title
        }
    }
}

/// "HANNIBAL · Claude Sonnet" with a dot that says whether the link is up.
struct StatusLine: View {
    @Environment(Remote.self) private var remote

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(remote.online ? Palette.success : Palette.warning)
                .frame(width: 6, height: 6)
                .shadow(color: (remote.online ? Palette.success : Palette.warning).opacity(0.6), radius: 3)
            Text(remote.online ? [remote.name, remote.model].filter { !$0.isEmpty }.joined(separator: " · ") : "Connecting to \(remote.name)…")
                .font(.system(size: 12))
                .foregroundStyle(Palette.text2)
                .lineLimit(1)
                .contentTransition(.opacity)
        }
        .animation(.easeInOut(duration: 0.25), value: remote.online)
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
        .buttonStyle(Press())
        .accessibilityLabel(label)
    }
}

private struct Banners: View {
    @Environment(Remote.self) private var remote

    var body: some View {
        VStack(spacing: 8) {
            if let problem = remote.problem, !remote.online {
                Banner(icon: "wifi.exclamationmark", text: problem, tint: Palette.warning, action: ("Retry", { remote.connect() }), close: nil)
            }
            if let notice = remote.banner {
                Banner(icon: "exclamationmark.circle", text: notice, tint: Palette.danger, action: nil, close: { remote.banner = nil })
                    .task(id: notice) {
                        try? await Task.sleep(nanoseconds: 7_000_000_000)
                        if remote.banner == notice { withAnimation { remote.banner = nil } }
                    }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .animation(.snappy(duration: 0.3), value: remote.banner)
        .animation(.snappy(duration: 0.3), value: remote.problem)
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
                    .buttonStyle(Press())
            }
            if let close {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Palette.text2)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(Press())
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

/// The chat, lazily: only the messages on screen are laid out, so a chat of hundreds opens as fast as a short one.
/// It starts at the end and stays there while a reply is written, unless the reader has scrolled up to read.
private struct Transcript: View {
    let size: CGFloat
    @Environment(Remote.self) private var remote
    @State private var position = ScrollPosition(edge: .bottom)
    /// The reader is at the end: new words keep it there.
    @State private var follow = true
    /// The reader's finger is on it, or it is still gliding from one.
    @State private var touching = false
    /// The message that was first before older ones were asked for: kept in place when they arrive above it.
    @State private var keep: String?

    var body: some View {
        let chat = remote.chat
        let busy = remote.run.running
        let lastID = chat.messages.last?.id
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                if chat.earlier > 0 {
                    EarlierRow(count: chat.earlier, loading: remote.fetchingEarlier) {
                        keep = chat.messages.first?.id
                        remote.more()
                    }
                }
                if chat.messages.isEmpty && remote.sending == nil {
                    if remote.opening == chat.id && !chat.id.isEmpty {
                        LoadingChat()
                    } else {
                        Welcome()
                            .containerRelativeFrame(.vertical) { length, _ in max(length - 60, 0) }
                    }
                }
                ForEach(chat.messages) { message in
                    let isLast = message.id == lastID
                    MessageRow(message: message, live: busy && isLast && !message.isUser, status: isLast ? remote.run.status : "", last: isLast, busy: busy, size: size)
                        .equatable()
                        .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 16)), removal: .opacity))
                }
                if let sending = remote.sending {
                    UserBubble(message: Message(id: "sending", role: "user", parts: [.text(sending)], at: 0), pending: true)
                        .transition(.opacity.combined(with: .offset(y: 16)))
                }
                if remote.run.resume == true, !busy {
                    InterruptedCard(resume: true)
                } else if !busy, let last = chat.messages.last, !last.isUser, last.incomplete == true {
                    InterruptedCard(resume: false)
                }
                if let approval = remote.run.approval {
                    ApprovalCard(approval: approval)
                }
                if let question = remote.run.question {
                    QuestionCard(question: question)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                Color.clear
                    .frame(height: 1)
                    .id("end")
            }
            .padding(.horizontal, 18)
            .padding(.top, 14)
            .padding(.bottom, 18)
            .scrollTargetLayout()
        }
        .scrollPosition($position)
        // The end at the leading edge: `.bottom` is also the middle across, which moved the whole chat sideways
        // whenever its content measured wider than the screen for a moment.
        .defaultScrollAnchor(.bottomLeading, for: .initialOffset)
        .scrollDismissesKeyboard(.interactively)
        .onScrollPhaseChange { _, phase, context in
            touching = phase == .tracking || phase == .interacting || phase == .decelerating
            // Taken hold of away from the end: following stops before anything else can move it.
            let geometry = context.geometry
            if touching, follow, geometry.contentSize.height - geometry.visibleRect.maxY >= 90 {
                withAnimation(.easeInOut(duration: 0.2)) { follow = false }
            }
        }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentSize.height - geometry.visibleRect.maxY < 90
        } action: { _, atEnd in
            // Only the reader's own scrolling says whether to follow: the end also moves when a reply grows, a card
            // arrives or the keyboard takes room.
            if touching || atEnd {
                withAnimation(.easeInOut(duration: 0.2)) { follow = atEnd }
            }
        }
        .onScrollGeometryChange(for: CGSize.self) { geometry in
            CGSize(width: geometry.containerSize.height, height: geometry.contentSize.height)
        } action: { _, _ in
            // A reply grew, a card came, rows were laid out or the keyboard took room: the end stays in view.
            if follow && !touching { position.scrollTo(edge: .bottom) }
        }
        .onChange(of: chat.earlier) { _, _ in
            if let keep {
                position.scrollTo(id: keep, anchor: .top)
                self.keep = nil
            }
        }
        .onChange(of: remote.sending) { _, now in
            if now != nil {
                follow = true
                withAnimation(.snappy(duration: 0.3)) { position.scrollTo(edge: .bottom) }
            }
        }
        .overlay(alignment: .bottom) {
            if !follow {
                Button {
                    Haptics.tap()
                    follow = true
                    withAnimation(.snappy(duration: 0.35)) { position.scrollTo(edge: .bottom) }
                } label: {
                    Image(systemName: "arrow.down")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Palette.text)
                        .frame(width: 36, height: 36)
                        .background(Palette.elevated, in: Circle())
                        .overlay(Circle().stroke(Palette.border, lineWidth: 1))
                        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
                }
                .buttonStyle(Press())
                .accessibilityLabel("Jump to latest")
                .padding(.bottom, 10)
                .transition(.opacity.combined(with: .scale(scale: 0.7)))
            }
        }
    }
}

/// "160 earlier messages": the computer keeps a long chat's start until it is asked for.
private struct EarlierRow: View {
    let count: Int
    let loading: Bool
    let action: () -> Void

    var body: some View {
        Button(action: {
            Haptics.tap()
            action()
        }) {
            HStack(spacing: 8) {
                if loading {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 11, weight: .bold))
                }
                Text(loading ? "Loading earlier messages" : "\(count) earlier message\(count == 1 ? "" : "s")")
                    .font(.system(size: 13, weight: .medium))
            }
            .foregroundStyle(Palette.text2)
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(Palette.hover.opacity(0.6), in: Capsule())
            .contentTransition(.opacity)
        }
        .buttonStyle(Press())
        .disabled(loading)
        .frame(maxWidth: .infinity)
        .animation(.snappy(duration: 0.2), value: loading)
        .accessibilityIdentifier("earlier")
    }
}

/// A chat on its way from the computer for the first time: its shape, shimmering.
private struct LoadingChat: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack {
                Spacer(minLength: 80)
                Skeleton(radius: 20).frame(width: 210, height: 44)
            }
            VStack(alignment: .leading, spacing: 10) {
                Skeleton(radius: 6).frame(height: 14)
                Skeleton(radius: 6).frame(height: 14)
                Skeleton(radius: 6).frame(width: 220, height: 14)
            }
            Skeleton(radius: 14).frame(height: 96)
            VStack(alignment: .leading, spacing: 10) {
                Skeleton(radius: 6).frame(height: 14)
                Skeleton(radius: 6).frame(width: 180, height: 14)
            }
        }
        .padding(.top, 8)
        .transition(.opacity)
        .accessibilityLabel("Loading the chat")
    }
}

private struct Welcome: View {
    @Environment(Remote.self) private var remote

    var body: some View {
        VStack(spacing: 18) {
            Mark(size: 58, bouncing: !remote.online)
            Text(greeting)
                .font(.system(size: 30, weight: .regular, design: .serif))
                .foregroundStyle(Palette.text)
                .multilineTextAlignment(.center)
            Text(remote.online ? "Whatever you send here runs in apiM on \(remote.name)." : "Waiting for apiM on \(remote.name)…")
                .font(.system(size: 15))
                .foregroundStyle(Palette.text2)
                .multilineTextAlignment(.center)
                .contentTransition(.opacity)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                    .symbolEffect(.bounce, options: .nonRepeating, value: approval.command)
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
                    Haptics.tap()
                    remote.allow(false)
                } label: {
                    Text("Deny").frame(maxWidth: .infinity)
                }
                .buttonStyle(Secondary())
                Button {
                    Haptics.success()
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
        .shadow(color: Palette.warning.opacity(0.12), radius: 14, y: 4)
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
                    Haptics.tap()
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
                let empty = answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                Button {
                    Haptics.tap()
                    remote.answer(answer.trimmingCharacters(in: .whitespacesAndNewlines))
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(Palette.accent, in: Circle())
                }
                .buttonStyle(Press())
                .disabled(empty)
                .opacity(empty ? 0.4 : 1)
                .animation(.easeInOut(duration: 0.15), value: empty)
                .accessibilityLabel("Answer")
            }
            Button("Skip") { remote.answer("") }
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Palette.text2)
                .buttonStyle(Press())
        }
        .padding(14)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Palette.accent.opacity(0.35), lineWidth: 1))
    }
}

/// "This reply stopped before it finished": carried on from where it stopped, or asked again.
private struct InterruptedCard: View {
    let resume: Bool
    @Environment(Remote.self) private var remote

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Palette.warning)
            VStack(alignment: .leading, spacing: 2) {
                Text("This reply stopped before it finished")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(Palette.text)
                Text(resume ? "Resume carries on from where it stopped, keeping what it did." : "Nothing arrived, so it is asked again from the start.")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Palette.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            Button(resume ? "Resume" : "Try again") {
                Haptics.tap()
                if resume { remote.resume() } else { remote.regenerate() }
            }
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(Palette.accent, in: Capsule())
            .buttonStyle(Press())
            .disabled(!remote.online)
        }
        .padding(12)
        .background(Palette.warning.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.warning.opacity(0.3), lineWidth: 1))
        .transition(.opacity)
    }
}
