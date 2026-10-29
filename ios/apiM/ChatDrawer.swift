import SwiftUI
import UIKit

/// The chats on the computer, newest first, grouped by when they were last touched.
struct ChatDrawer: View {
    @Environment(Remote.self) private var remote
    let close: () -> Void
    let openSettings: () -> Void
    @State private var search = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Mark(size: 30)
                Text("apiM")
                    .font(.system(size: 24, weight: .semibold, design: .serif))
                    .foregroundStyle(Palette.text)
                Spacer()
            }
            .padding(.horizontal, 18)
            .padding(.top, 14)
            .padding(.bottom, 14)

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Palette.muted)
                TextField("Search chats", text: $search)
                    .font(.system(size: 15))
                    .foregroundStyle(Palette.text)
                    .submitLabel(.search)
                if !search.isEmpty {
                    Button { search = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.muted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            .background(Palette.hover.opacity(0.65), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal, 14)

            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                remote.newChat()
                close()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 15, weight: .medium))
                        .frame(width: 22)
                    Text("New chat")
                        .font(.system(size: 15.5, weight: .medium))
                    Spacer()
                }
                .foregroundStyle(Palette.accent)
                .padding(.horizontal, 12)
                .frame(height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 6)
            .padding(.top, 8)
            .disabled(remote.phase != .online)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2, pinnedViews: []) {
                    let groups = sections
                    if groups.isEmpty {
                        Text(search.isEmpty ? (remote.phase == .online ? "No chats yet" : "Chats appear once \(remote.name) answers") : "Nothing matches \u{201c}\(search)\u{201d}")
                            .font(.system(size: 14))
                            .foregroundStyle(Palette.muted)
                            .padding(.horizontal, 12)
                            .padding(.top, 18)
                    }
                    ForEach(groups) { group in
                        Text(group.title)
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(Palette.muted)
                            .padding(.horizontal, 12)
                            .padding(.top, 16)
                            .padding(.bottom, 4)
                        ForEach(group.rows) { row in
                            Row(row: row, current: row.id == remote.chat.id, opening: row.id == remote.opening) {
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                remote.open(row.id)
                                close()
                            }
                        }
                    }
                }
                .padding(.horizontal, 6)
                .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.immediately)

            Rectangle().fill(Palette.border).frame(height: 1)
            Button(action: openSettings) {
                HStack(spacing: 10) {
                    Image(systemName: "desktopcomputer")
                        .font(.system(size: 16))
                        .foregroundStyle(Palette.text2)
                        .frame(width: 34, height: 34)
                        .background(Palette.hover.opacity(0.7), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(remote.name)
                            .font(.system(size: 14.5, weight: .semibold))
                            .foregroundStyle(Palette.text)
                            .lineLimit(1)
                        HStack(spacing: 5) {
                            Circle()
                                .fill(remote.phase == .online ? Palette.success : Palette.warning)
                                .frame(width: 6, height: 6)
                            Text(remote.phase == .online ? "Connected" : "Connecting…")
                                .font(.system(size: 12))
                                .foregroundStyle(Palette.text2)
                        }
                    }
                    Spacer()
                    Image(systemName: "gearshape")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Palette.text2)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")
        }
        .background(Palette.bg2.ignoresSafeArea())
    }

    private struct Day: Identifiable {
        var title: String
        var rows: [ChatRow]
        var id: String { title }
    }

    private var sections: [Day] {
        let wanted = search.trimmingCharacters(in: .whitespaces).lowercased()
        let rows = wanted.isEmpty ? remote.chats : remote.chats.filter { $0.title.lowercased().contains(wanted) }
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        var out: [Day] = []
        for row in rows {
            let day = calendar.startOfDay(for: Date(timeIntervalSince1970: row.updated / 1000))
            let days = calendar.dateComponents([.day], from: day, to: today).day ?? 0
            let title: String
            switch days {
            case ..<1: title = "Today"
            case 1: title = "Yesterday"
            case 2..<7: title = "Previous 7 days"
            case 7..<30: title = "Previous 30 days"
            default: title = day.formatted(.dateTime.month(.wide).year())
            }
            if out.last?.title == title {
                out[out.count - 1].rows.append(row)
            } else {
                out.append(Day(title: title, rows: [row]))
            }
        }
        return out
    }
}

private struct Row: View {
    let row: ChatRow
    let current: Bool
    let opening: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(row.title.isEmpty ? "Untitled" : row.title)
                    .font(.system(size: 15))
                    .foregroundStyle(Palette.text)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if opening {
                    ProgressView().controlSize(.small)
                } else if row.running {
                    Dots(size: 4.5)
                        .accessibilityLabel("Working")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 42)
            .background(current ? Palette.hover : Color.clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// What this phone is paired with, and the way out.
struct SettingsSheet: View {
    @Environment(Remote.self) private var remote
    @Environment(\.dismiss) private var dismiss
    @State private var confirm = false
    @State private var scanning = false

    var body: some View {
        NavigationStack {
            List {
                Section("Computer") {
                    LabeledContent("Name", value: remote.name)
                    LabeledContent("Status", value: remote.phase == .online ? "Connected" : "Connecting…")
                    if let pairing = remote.pairing {
                        LabeledContent("Address", value: pairing.hosts.map { "\($0):\(pairing.port)" }.joined(separator: ", "))
                    }
                    if !remote.model.isEmpty {
                        LabeledContent("Model", value: remote.model)
                    }
                }
                if let problem = remote.problem, remote.phase != .online {
                    Section("Last problem") {
                        Text(problem)
                            .font(.system(size: 14))
                            .foregroundStyle(Palette.text2)
                        Button("Try again") { remote.connect() }
                    }
                }
                Section {
                    Button("Pair with another computer") { scanning = true }
                    Button("Unpair this phone", role: .destructive) { confirm = true }
                } footer: {
                    Text("Messages and approvals travel straight to apiM on your computer, encrypted with the key in the code you scanned. Nothing goes through a server.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.bg2)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Unpair this phone?", isPresented: $confirm, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) {
                    dismiss()
                    remote.unpair()
                }
            } message: {
                Text("To use it again, scan the code in apiM's Settings › Phone.")
            }
            .sheet(isPresented: $scanning) {
                ScanSheet { link in
                    if remote.pair(link) {
                        scanning = false
                        dismiss()
                        return true
                    }
                    return false
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
