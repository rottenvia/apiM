import SwiftUI

/// The computer's settings that make sense from a phone, changed there as they are here, then this phone's own.
struct SettingsView: View {
    @Environment(Remote.self) private var remote
    @Environment(\.dismiss) private var dismiss
    @AppStorage("appearance") private var appearance = 0
    @AppStorage("textSize") private var textSize = 1
    @AppStorage("haptics") private var haptics = true
    @State private var effort = false
    @State private var confirmAuto = false
    @State private var unpairing = false
    @State private var scanning = false

    var body: some View {
        NavigationStack {
            List {
                if let conf = remote.conf {
                    computerSettings(conf)
                } else {
                    Section {
                        Label(remote.online ? "Waiting for \(remote.name)'s settings…" : "Connect to \(remote.name) to change its settings.", systemImage: "desktopcomputer")
                            .font(.system(size: 14))
                            .foregroundStyle(Palette.text2)
                    }
                    .listRowBackground(Palette.surface)
                }
                phone
                connection
                Section {
                } footer: {
                    Text("apiM \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "") (\(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""))")
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Palette.bg2)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $effort) {
                EffortSheet()
            }
            .alert("Run everything without asking?", isPresented: $confirmAuto) {
                Button("Cancel", role: .cancel) {}
                Button("Run automatically", role: .destructive) {
                    Haptics.press()
                    remote.set("approval", "auto")
                }
            } message: {
                Text("Code the assistant writes will run on \(remote.name) without asking, and so will programs it builds or downloads and packages it installs. It can read files anywhere on the computer except where sign-ins and keys are kept. Keep a restore point.")
            }
            .confirmationDialog("Unpair this phone?", isPresented: $unpairing, titleVisibility: .visible) {
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
        .presentationDetents([.large])
        .presentationBackground(Palette.bg2)
    }

    // MARK: the computer's

    @ViewBuilder
    private func computerSettings(_ conf: Conf) -> some View {
        Section {
            NavigationLink {
                ModelList()
                    .navigationTitle("Model")
                    .navigationBarTitleDisplayMode(.inline)
            } label: {
                value("Model", remote.models.first { $0.id == conf.model }?.label ?? remote.model)
            }
            if !conf.efforts.isEmpty {
                Button {
                    effort = true
                } label: {
                    HStack {
                        value("Effort", conf.efforts.first { $0.id == conf.effort }?.label ?? conf.effort.capitalized)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Palette.muted.opacity(0.7))
                    }
                }
                .buttonStyle(.plain)
            }
        } header: {
            Text("On \(remote.name)")
        } footer: {
            Text("The model and effort the next message in this chat goes with, as the computer's own menus set them.")
        }
        .listRowBackground(Palette.surface)

        Section {
            option("Web search on", "The assistant looks things up when it decides it needs to.", conf.web == "auto") { remote.set("web", "auto") }
            option("Every message", "Same tool, nudged to look things up by default.", conf.web == "always") { remote.set("web", "always") }
            option("Off", "Answers from the model's own knowledge only.", conf.web == "off") { remote.set("web", "off") }
        } header: {
            Text("Web search")
        }
        .listRowBackground(Palette.surface)

        Section {
            option("Thorough", "Reads full pages on every search. The most expensive.", conf.search == "quality") { remote.set("search", "quality") }
            option("Balanced", "Skims first, then reads full pages only for what is missing. Roughly half the cost.", conf.search == "balanced", badge: "Recommended") { remote.set("search", "balanced") }
            option("Frugal", "Skims only, and asks fewer questions per search. Cheapest.", conf.search == "cheap") { remote.set("search", "cheap") }
        } header: {
            Text("How hard a search looks")
        } footer: {
            Text("Each search is charged separately, and one question can start several.")
        }
        .listRowBackground(Palette.surface)

        Section {
            Toggle(isOn: Binding(get: { conf.computer }, set: { Haptics.pick(); remote.set("computer", $0) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Use the computer")
                    Text("The assistant may see \(remote.name)'s screen and use its mouse and keyboard.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(Palette.text2)
                }
            }
            .tint(Palette.accent)
        }
        .listRowBackground(Palette.surface)

        Section {
            option("Ask me first", "You see each command and click Run or Skip before anything happens.", conf.approval == "manual", badge: "Recommended") { remote.set("approval", "manual") }
            option("Ask only for the risky", "Runs on its own, but asks before installing, pushing, or touching other programs.", conf.approval == "critical") { remote.set("approval", "critical") }
            option("Run automatically", "Nothing asks, installing into the computer included.", conf.approval == "auto") {
                if conf.approval != "auto" { confirmAuto = true }
            }
        } header: {
            Text("Running commands")
        } footer: {
            Text("When the assistant writes code, it can run it to check it works and fix its own mistakes.")
        }
        .listRowBackground(Palette.surface)

        Section {
            Toggle(isOn: Binding(get: { conf.lessons }, set: { Haptics.pick(); remote.set("lessons", $0) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Learn from this project")
                    Text("Keeps a LESSONS.md of what a task proved, and reads it back next time.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(Palette.text2)
                }
            }
            .tint(Palette.accent)
        }
        .listRowBackground(Palette.surface)

        if !conf.keys.isEmpty {
            Section {
                ForEach(conf.keys, id: \.name) { key in
                    HStack {
                        Text(key.name)
                        Spacer()
                        Label(key.set ? "Set" : "Not set", systemImage: key.set ? "checkmark.circle.fill" : "circle.dashed")
                            .labelStyle(.titleAndIcon)
                            .font(.system(size: 13.5, weight: .medium))
                            .foregroundStyle(key.set ? Palette.success : Palette.muted)
                    }
                }
            } header: {
                Text("API keys")
            } footer: {
                Text("Keys stay on \(remote.name) and are never sent to this phone. Add or change them there, in Settings › API keys.")
            }
            .listRowBackground(Palette.surface)
        }
    }

    // MARK: this phone's

    private var phone: some View {
        Section {
            Picker("Appearance", selection: $appearance) {
                Text("System").tag(0)
                Text("Light").tag(1)
                Text("Dark").tag(2)
            }
            .pickerStyle(.segmented)
            .listRowSeparator(.hidden)
            VStack(alignment: .leading, spacing: 8) {
                Text("Reply text size")
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.text2)
                Picker("Reply text size", selection: $textSize) {
                    Text("Small").tag(0)
                    Text("Default").tag(1)
                    Text("Large").tag(2)
                }
                .pickerStyle(.segmented)
            }
            Toggle("Haptics", isOn: $haptics)
                .tint(Palette.accent)
        } header: {
            Text("This phone")
        }
        .listRowBackground(Palette.surface)
    }

    @ViewBuilder
    private var connection: some View {
        Section {
            LabeledContent("Computer", value: remote.name)
            LabeledContent("Status") {
                HStack(spacing: 6) {
                    Circle()
                        .fill(remote.online ? Palette.success : Palette.warning)
                        .frame(width: 7, height: 7)
                    Text(remote.online ? "Connected" : "Connecting…")
                }
            }
            if let pairing = remote.pairing {
                LabeledContent("Address", value: pairing.hosts.map { "\($0):\(pairing.port)" }.joined(separator: ", "))
            }
        } header: {
            Text("Connection")
        }
        .listRowBackground(Palette.surface)
        if let problem = remote.problem, !remote.online {
            Section("Last problem") {
                Text(problem)
                    .font(.system(size: 14))
                    .foregroundStyle(Palette.text2)
                Button("Try again") { remote.connect() }
            }
            .listRowBackground(Palette.surface)
        }
        Section {
            Button("Pair with another computer") { scanning = true }
            Button("Unpair this phone", role: .destructive) { unpairing = true }
        } footer: {
            Text("Messages and approvals travel straight to apiM on your computer, encrypted with the key in the code you scanned. Nothing goes through a server.")
        }
        .listRowBackground(Palette.surface)
    }

    // MARK: pieces

    private func value(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
                .foregroundStyle(Palette.text)
            Spacer()
            Text(value)
                .foregroundStyle(Palette.text2)
                .lineLimit(1)
                .contentTransition(.opacity)
        }
        .contentShape(Rectangle())
    }

    /// One choice of several, as the computer's settings list them: a name, what it does, a tick on the one in use.
    private func option(_ title: String, _ about: String, _ selected: Bool, badge: String = "", pick: @escaping () -> Void) -> some View {
        Button {
            guard !selected else { return }
            Haptics.pick()
            pick()
        } label: {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(title)
                            .font(.system(size: 16, weight: selected ? .semibold : .regular))
                            .foregroundStyle(Palette.text)
                        if !badge.isEmpty {
                            Text(badge)
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(Palette.accent)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Palette.accentSoft, in: Capsule())
                        }
                    }
                    Text(about)
                        .font(.system(size: 12.5))
                        .foregroundStyle(Palette.text2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Image(systemName: "checkmark")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Palette.accent)
                    .opacity(selected ? 1 : 0)
                    .scaleEffect(selected ? 1 : 0.4)
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(.spring(response: 0.3, dampingFraction: 0.68), value: selected)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
