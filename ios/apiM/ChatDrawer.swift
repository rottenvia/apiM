import SwiftUI
import UIKit

/// The chats on the computer, newest first, grouped by when they were last touched. Swipe a chat left to archive or
/// delete it; hold it for the same and Rename.
struct ChatDrawer: View {
    @Environment(Remote.self) private var remote
    @Environment(Screen.self) private var screen
    let close: () -> Void
    @State private var search = ""
    @State private var archived = false

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
                    Button {
                        search = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.muted)
                    }
                    .buttonStyle(Press())
                    .accessibilityLabel("Clear search")
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            .background(Palette.hover.opacity(0.65), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal, 14)
            .animation(.snappy(duration: 0.2), value: search.isEmpty)

            Button {
                Haptics.tap()
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
            .buttonStyle(Press(scale: 0.97))
            .padding(.horizontal, 6)
            .padding(.top, 8)
            .disabled(!remote.online)

            let stored = remote.chats.filter(\.isArchived).count
            if stored > 0 {
                Picker("Show", selection: $archived.animation(.snappy(duration: 0.25))) {
                    Text("Chats").tag(false)
                    Text("Archived (\(stored))").tag(true)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 14)
                .padding(.top, 6)
                .padding(.bottom, 4)
            }

            list

            Rectangle().fill(Palette.border).frame(height: 1)
            Button {
                close()
                screen.settings = true
            } label: {
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
                                .fill(remote.online ? Palette.success : Palette.warning)
                                .frame(width: 6, height: 6)
                            Text(remote.online ? "Connected" : "Connecting…")
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
            .buttonStyle(Press(scale: 0.98))
            .accessibilityLabel("Settings")
        }
        .background(Palette.bg2.ignoresSafeArea())
        .onChange(of: remote.chats.contains(where: \.isArchived)) { _, any in
            if !any { archived = false }
        }
    }

    private var list: some View {
        let groups = sections
        return List {
            if groups.isEmpty {
                Text(emptyText)
                    .font(.system(size: 14))
                    .foregroundStyle(Palette.muted)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .padding(.top, 8)
            }
            ForEach(groups) { group in
                Section {
                    ForEach(group.rows) { row in
                        Row(row: row, current: row.id == remote.chat.id, opening: row.id == remote.opening) {
                            Haptics.tap()
                            remote.open(row.id)
                            close()
                        }
                        .listRowInsets(EdgeInsets(top: 1, leading: 6, bottom: 1, trailing: 6))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button {
                                screen.deleting = row
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            .tint(Palette.danger)
                            Button {
                                Haptics.tap()
                                remote.archive(row.id, !row.isArchived)
                            } label: {
                                Label(row.isArchived ? "Unarchive" : "Archive", systemImage: row.isArchived ? "tray.and.arrow.up" : "archivebox")
                            }
                            .tint(Palette.warning)
                        }
                        .contextMenu {
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
                        }
                    }
                } header: {
                    Text(group.title)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(Palette.muted)
                        .textCase(nil)
                        .padding(.leading, 6)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.immediately)
        .environment(\.defaultMinListRowHeight, 40)
        .animation(.snappy(duration: 0.3), value: remote.chats)
    }

    private var emptyText: String {
        if !search.isEmpty { return "Nothing matches \u{201c}\(search)\u{201d}" }
        if archived { return "No archived chats" }
        return remote.online ? "No chats yet" : "Chats appear once \(remote.name) answers"
    }

    private struct Day: Identifiable {
        var title: String
        var rows: [ChatRow]
        var id: String { title }
    }

    private var sections: [Day] {
        let wanted = search.trimmingCharacters(in: .whitespaces).lowercased()
        let rows = remote.chats.filter { $0.isArchived == archived && (wanted.isEmpty || $0.title.lowercased().contains(wanted)) }
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
                    .font(.system(size: 15, weight: current ? .medium : .regular))
                    .foregroundStyle(Palette.text)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if opening {
                    ProgressView().controlSize(.small)
                        .transition(.opacity)
                } else if row.running {
                    Dots(size: 4.5)
                        .accessibilityLabel("Working")
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 42)
            .background(current ? Palette.hover : Color.clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
            .animation(.snappy(duration: 0.2), value: current)
        }
        .buttonStyle(Press(scale: 0.97))
    }
}
