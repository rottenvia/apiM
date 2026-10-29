import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Something going with the next message: a photo (sent as a JPEG, its name without an extension) or a file (as it is).
private struct Attachment: Identifiable {
    let id = UUID()
    let name: String
    let data: Data
    /// Photos only.
    let thumbnail: UIImage?
}

/// The message box, with what the computer's own box has around it: attachments, the model, the effort, the web
/// and the computer.
struct Composer: View {
    @Environment(Remote.self) private var remote
    @Environment(Screen.self) private var screen
    @State private var draft = ""
    /// What was in the box before a message was taken into it to edit.
    @State private var kept = ""
    @State private var items: [PhotosPickerItem] = []
    @State private var attachments: [Attachment] = []
    @State private var picking = false
    @State private var camera = false
    @State private var importing = false
    @FocusState private var focused: Bool

    /// The computer takes a message a few MB at most; a file over this is said, not sent.
    private static let largest = 20 << 20

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var empty: Bool { trimmed.isEmpty && attachments.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let editing = screen.editing {
                HStack(spacing: 8) {
                    Image(systemName: "pencil")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Palette.accent)
                    Text("Editing: the replies after it are written again")
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(Palette.text2)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Button {
                        cancelEdit()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 16))
                            .foregroundStyle(Palette.muted)
                    }
                    .buttonStyle(Press())
                    .accessibilityLabel("Cancel editing")
                }
                .padding(.horizontal, 4)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .id(editing.id)
            }
            if !attachments.isEmpty {
                strip
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            TextField(placeholder, text: $draft, axis: .vertical)
                .font(Typeface.body)
                .foregroundStyle(Palette.text)
                .lineLimit(1...7)
                .focused($focused)
                .accessibilityIdentifier("composer")
                .padding(.horizontal, 4)
            HStack(spacing: 6) {
                attachMenu
                ModelChip()
                EffortChip()
                ToolsMenu()
                Spacer(minLength: 0)
                sendButton
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(focused ? Palette.borderStrong : Palette.border, lineWidth: 1))
        .shadow(color: .black.opacity(focused ? 0.08 : 0.05), radius: 14, y: 2)
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
        .padding(.top, 2)
        .background(Palette.bg)
        .animation(.snappy(duration: 0.28), value: attachments.map(\.id))
        .animation(.snappy(duration: 0.28), value: screen.editing?.id)
        .animation(.easeInOut(duration: 0.2), value: focused)
        .photosPicker(isPresented: $picking, selection: $items, maxSelectionCount: 4, matching: .images)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { files(urls) }
        }
        .fullScreenCover(isPresented: $camera) {
            CameraPicker(taken: { image in photo(image) }, done: { camera = false })
                .ignoresSafeArea()
        }
        .onChange(of: items) { _, picked in
            guard !picked.isEmpty else { return }
            items = []
            Task { await load(picked) }
        }
        .onChange(of: screen.editing?.id) { _, id in
            guard id != nil, let message = screen.editing else { return }
            kept = draft
            draft = message.text
            focused = true
        }
    }

    // MARK: pieces

    private var strip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { item in
                    Group {
                        if let thumbnail = item.thumbnail {
                            Image(uiImage: thumbnail)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 58, height: 58)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .onTapGesture {
                                    let id = "local-\(item.id.uuidString)"
                                    Images.shared.keep(id, image: thumbnail)
                                    screen.viewer = Picture(id: id, name: "Photo")
                                }
                        } else {
                            HStack(spacing: 7) {
                                Image(systemName: "doc.fill")
                                    .font(.system(size: 16))
                                    .foregroundStyle(Palette.accent)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(item.name)
                                        .font(.system(size: 12.5, weight: .medium))
                                        .foregroundStyle(Palette.text)
                                        .lineLimit(1)
                                    Text(ByteCountFormatter.string(fromByteCount: Int64(item.data.count), countStyle: .file))
                                        .font(.system(size: 11))
                                        .foregroundStyle(Palette.muted)
                                }
                            }
                            .padding(.horizontal, 10)
                            .frame(maxWidth: 190, minHeight: 58, maxHeight: 58)
                            .background(Palette.hover.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        Button {
                            Haptics.tap()
                            attachments.removeAll { $0.id == item.id }
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 20, height: 20)
                                .background(Color.black.opacity(0.6), in: Circle())
                        }
                        .buttonStyle(Press())
                        .padding(4)
                        .accessibilityLabel("Remove \(item.thumbnail == nil ? item.name : "photo")")
                    }
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
            }
            .padding(.vertical, 2)
        }
    }

    private var attachMenu: some View {
        Menu {
            Button {
                picking = true
            } label: {
                Label("Photos", systemImage: "photo.on.rectangle")
            }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button {
                    camera = true
                } label: {
                    Label("Camera", systemImage: "camera")
                }
            }
            Button {
                importing = true
            } label: {
                Label("Files", systemImage: "folder")
            }
            if UIPasteboard.general.hasImages {
                Button {
                    if let image = UIPasteboard.general.image { photo(image) }
                } label: {
                    Label("Paste Image", systemImage: "doc.on.clipboard")
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Palette.text)
                .frame(width: 34, height: 34)
                .overlay(Circle().stroke(Palette.border, lineWidth: 1))
                .contentShape(Circle())
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Add")
    }

    private var sendButton: some View {
        let stopping = remote.run.running && empty && screen.editing == nil
        let ready = !empty && remote.online
        return Button {
            if stopping {
                Haptics.press()
                remote.stop()
            } else {
                send()
            }
        } label: {
            Image(systemName: stopping ? "stop.fill" : "arrow.up")
                .font(.system(size: stopping ? 13 : 16, weight: .bold))
                .foregroundStyle(stopping ? Palette.bg : .white)
                .frame(width: 34, height: 34)
                .background(stopping ? Palette.text : (ready ? Palette.accent : Palette.muted.opacity(0.45)), in: Circle())
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(Press(scale: 0.86))
        .disabled(!stopping && !ready)
        .accessibilityLabel(stopping ? "Stop" : "Send")
        .animation(.snappy(duration: 0.25), value: stopping)
        .animation(.easeInOut(duration: 0.15), value: ready)
    }

    private var placeholder: String {
        if screen.editing != nil { return "Edit your message" }
        if remote.run.running { return "Add to the task…" }
        return remote.chat.messages.isEmpty ? "Message apiM" : "Reply to apiM"
    }

    // MARK: actions

    private func send() {
        guard !empty else { return }
        Haptics.tap()
        if let editing = screen.editing {
            remote.edit(editing.id, trimmed)
            withAnimation(.snappy(duration: 0.25)) { screen.editing = nil }
            draft = kept
            kept = ""
        } else {
            remote.say(trimmed, files: attachments.map { Remote.Outgoing(name: $0.name, data: $0.data) })
            draft = ""
            attachments = []
        }
        // The keyboard goes down so the reply has the screen, as in Claude.
        focused = false
    }

    private func cancelEdit() {
        Haptics.tap()
        withAnimation(.snappy(duration: 0.25)) { screen.editing = nil }
        draft = kept
        kept = ""
    }

    private var photos: Int { attachments.filter { $0.thumbnail != nil }.count }

    private func photo(_ image: UIImage) {
        guard let made = Shrink.jpeg(image) else { return }
        let (jpeg, thumb) = made
        attachments.append(Attachment(name: "photo-\(photos + 1)", data: jpeg, thumbnail: thumb))
    }

    /// Photos go as JPEGs no longer than 1600 px on a side: what a model reads well, a few hundred KB each.
    private func load(_ picked: [PhotosPickerItem]) async {
        for item in picked {
            guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { continue }
            let made = await Task.detached(priority: .userInitiated) { Shrink.jpeg(image) }.value
            guard let made else { continue }
            let (jpeg, thumb) = made
            await MainActor.run {
                if photos < 4 { attachments.append(Attachment(name: "photo-\(photos + 1)", data: jpeg, thumbnail: thumb)) }
            }
        }
    }

    private func files(_ urls: [URL]) {
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            guard data.count <= Composer.largest else {
                remote.banner = "\(url.lastPathComponent) is over 20 MB, too big to send from the phone."
                continue
            }
            attachments.append(Attachment(name: url.lastPathComponent, data: data, thumbnail: nil))
        }
    }
}

/// Off the main thread: a picture as the JPEG that is sent, and the thumbnail shown in the box.
enum Shrink {
    static func jpeg(_ image: UIImage) -> (Data, UIImage)? {
        let scale = min(1, 1600 / max(image.size.width, image.size.height, 1))
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        guard let jpeg = resized.jpegData(compressionQuality: 0.8) else { return nil }
        let thumb = UIGraphicsImageRenderer(size: CGSize(width: 160, height: 160 * size.height / max(size.width, 1)), format: format).image { context in
            resized.draw(in: context.format.bounds)
        }
        return (jpeg, thumb)
    }
}

/// The model in use; tapped, the model menu.
private struct ModelChip: View {
    @Environment(Remote.self) private var remote
    @Environment(Screen.self) private var screen

    var body: some View {
        Button {
            Haptics.tap()
            screen.models = true
        } label: {
            let name = remote.modelShort.isEmpty ? "Model" : remote.modelShort
            HStack(spacing: 4) {
                // Its own width, not a share of the row's: a long custom name is cut here instead.
                Text(name.count > 16 ? String(name.prefix(15)) + "…" : name)
                    .lineLimit(1)
                    .contentTransition(.opacity)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8.5, weight: .bold))
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Palette.text2)
            .padding(.horizontal, 10)
            .frame(minHeight: 32)
            .fixedSize()
            .background(Palette.hover.opacity(0.55), in: Capsule())
        }
        .buttonStyle(Press())
        .disabled(remote.conf == nil)
        .animation(.snappy(duration: 0.25), value: remote.modelShort)
        .accessibilityLabel("Model: \(remote.modelShort)")
        .accessibilityIdentifier("model")
    }
}

/// How hard the model thinks, for a model that does; tapped, the effort slider.
private struct EffortChip: View {
    @Environment(Remote.self) private var remote
    @Environment(Screen.self) private var screen

    var body: some View {
        if let conf = remote.conf, !conf.efforts.isEmpty {
            let depth = conf.efforts.first { $0.id == conf.effort }
            Button {
                Haptics.tap()
                screen.effort = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: EffortChip.symbol(conf.effort))
                        .font(.system(size: 12, weight: .semibold))
                        .contentTransition(.symbolEffect(.replace))
                    Text(depth?.label ?? conf.effort.capitalized)
                        .lineLimit(1)
                        .contentTransition(.opacity)
                }
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(conf.effort == "auto" ? Palette.text2 : Palette.accent)
                .padding(.horizontal, 10)
                .frame(minHeight: 32)
                .background(conf.effort == "auto" ? Palette.hover.opacity(0.55) : Palette.accentSoft, in: Capsule())
            }
            .buttonStyle(Press())
            .animation(.snappy(duration: 0.25), value: conf.effort)
            .accessibilityLabel("Effort: \(depth?.label ?? conf.effort)")
            .accessibilityIdentifier("effort")
            .transition(.scale(scale: 0.8).combined(with: .opacity))
        }
    }

    static func symbol(_ effort: String) -> String {
        switch effort {
        case "auto": return "sparkles"
        case "none": return "gauge.with.dots.needle.0percent"
        case "low": return "gauge.with.dots.needle.33percent"
        case "medium": return "gauge.with.dots.needle.50percent"
        case "high": return "gauge.with.dots.needle.67percent"
        default: return "gauge.with.dots.needle.100percent"
        }
    }
}

/// The web search and computer use switches, as the chips beside the computer's box.
private struct ToolsMenu: View {
    @Environment(Remote.self) private var remote

    var body: some View {
        if let conf = remote.conf {
            Menu {
                Picker("Web search", selection: Binding(get: { conf.web }, set: { Haptics.pick(); remote.set("web", $0) })) {
                    Text("Web search on").tag("auto")
                    Text("Search on every message").tag("always")
                    Text("Web search off").tag("off")
                }
                .pickerStyle(.inline)
                Divider()
                Toggle(isOn: Binding(get: { conf.computer }, set: { Haptics.pick(); remote.set("computer", $0) })) {
                    Label("Use the computer", systemImage: "desktopcomputer")
                }
            } label: {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "globe")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(conf.web == "off" ? Palette.muted : Palette.accent)
                        .frame(width: 34, height: 32)
                        .background(conf.web == "off" ? Palette.hover.opacity(0.55) : Palette.accentSoft, in: Capsule())
                    if conf.computer {
                        Image(systemName: "desktopcomputer")
                            .font(.system(size: 7.5, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 15, height: 15)
                            .background(Palette.accent, in: Circle())
                            .overlay(Circle().stroke(Palette.surface, lineWidth: 1.5))
                            .offset(x: 4, y: -4)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .animation(.snappy(duration: 0.25), value: conf.computer)
                .animation(.easeInOut(duration: 0.2), value: conf.web)
            }
            .menuOrder(.fixed)
            .accessibilityLabel("Web and computer")
            .accessibilityIdentifier("tools")
        }
    }
}

/// The camera, for a photo to send.
private struct CameraPicker: UIViewControllerRepresentable {
    let taken: (UIImage) -> Void
    let done: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.taken(image) }
            parent.done()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.done()
        }
    }
}
