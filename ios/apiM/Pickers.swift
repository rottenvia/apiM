import SwiftUI

/// The computer's model menu: its own models, then the user's. Picking one changes it there, for the chat on screen.
struct ModelList: View {
    var picked: () -> Void = {}
    @Environment(Remote.self) private var remote

    var body: some View {
        let current = remote.conf?.model
        List {
            Section {
                ForEach(remote.models.filter { !$0.mine }) { row($0, current: current) }
            }
            let mine = remote.models.filter(\.mine)
            if !mine.isEmpty {
                Section("Your models") {
                    ForEach(mine) { row($0, current: current) }
                }
            }
            Section {
            } footer: {
                Text("Add any OpenRouter or Claude model on \(remote.name), in Settings › Model, or ask for it in a chat.")
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Palette.bg2)
    }

    private func row(_ model: ModelRow, current: String?) -> some View {
        let selected = model.id == current
        return Button {
            guard !selected else { return picked() }
            Haptics.pick()
            remote.set("model", model.id)
            // The tick moves before the sheet goes, so the pick is seen.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) { picked() }
        } label: {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(model.label)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Palette.text)
                        if model.vision {
                            Image(systemName: "eye")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(Palette.muted)
                                .accessibilityLabel("Reads pictures")
                        }
                    }
                    if !model.about.isEmpty {
                        Text(model.about)
                            .font(.system(size: 13.5))
                            .foregroundStyle(Palette.text2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !model.specs.isEmpty {
                        Text(model.specs)
                            .font(.system(size: 12))
                            .foregroundStyle(Palette.muted)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "checkmark")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Palette.accent)
                    .opacity(selected ? 1 : 0)
                    .scaleEffect(selected ? 1 : 0.4)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(selected ? Palette.accentSoft.opacity(0.6) : Palette.surface)
        .animation(.spring(response: 0.3, dampingFraction: 0.68), value: selected)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct ModelSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ModelList(picked: { dismiss() })
                .navigationTitle("Model")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Palette.bg2)
    }
}

/// How hard the model thinks: Auto, or one of the model's own depths on a slider, as the computer's effort menu
/// has it. A model without a thinking step says so.
struct EffortSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        EffortPanel()
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 12)
            .frame(maxHeight: .infinity, alignment: .top)
            .presentationDetents([.height(340)])
            .presentationDragIndicator(.visible)
            .presentationBackground(Palette.bg2)
    }
}

struct EffortPanel: View {
    @Environment(Remote.self) private var remote
    /// The depth Auto was switched on from, so switching it off goes back there.
    @AppStorage("effortKept") private var kept = "medium"

    var body: some View {
        let conf = remote.conf
        let depths = (conf?.efforts ?? []).filter { $0.id != "auto" }
        let auto = conf?.effort == "auto"
        let current = auto ? nearest(kept, in: depths) : (conf?.effort ?? "")
        let index = depths.firstIndex { $0.id == current } ?? 0
        let about = conf?.efforts.first { $0.id == (auto ? "auto" : current) }
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("Effort")
                        .foregroundStyle(Palette.text2)
                    if !depths.isEmpty {
                        Text(auto ? "Auto" : (depths.first { $0.id == current }?.label ?? current))
                            .fontWeight(.semibold)
                            .foregroundStyle(Palette.text)
                            .contentTransition(.numericText())
                    }
                }
                .font(.system(size: 20))
                Spacer()
                if !depths.isEmpty {
                    Toggle("Auto", isOn: Binding(get: { auto }, set: { on in
                        Haptics.pick()
                        if on { kept = current }
                        remote.set("effort", on ? "auto" : nearest(kept, in: depths))
                    }))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Palette.text2)
                    .tint(Palette.accent)
                    .fixedSize()
                    .accessibilityIdentifier("effort-auto")
                }
            }
            Text(depths.isEmpty ? "\(remote.modelShort) answers without a thinking step" : "How deeply \(remote.modelShort) reasons before replying")
                .font(.system(size: 13))
                .foregroundStyle(Palette.muted)
                .padding(.top, 4)
            if !depths.isEmpty {
                EffortSlider(levels: depths, index: index, dimmed: auto) { picked in
                    remote.set("effort", depths[picked].id)
                }
                .padding(.top, 22)
                if let about {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(about.about)
                            .font(.system(size: 14))
                            .foregroundStyle(Palette.text2)
                            .fixedSize(horizontal: false, vertical: true)
                        if !about.warn.isEmpty {
                            Label(about.warn, systemImage: "exclamationmark.triangle")
                                .font(.system(size: 12.5))
                                .foregroundStyle(Palette.warning)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.top, 18)
                    .id(about.id)
                    .transition(.opacity)
                }
            }
        }
        .animation(.snappy(duration: 0.25), value: conf?.effort)
    }

    /// `want` when the model has it, else its middle depth.
    private func nearest(_ want: String, in depths: [Depth]) -> String {
        if depths.contains(where: { $0.id == want }) { return want }
        return depths.isEmpty ? want : depths[depths.count / 2].id
    }
}

/// A stop for each depth, "Faster" to "Smarter": dragged, the knob follows the finger and ticks at each stop; let
/// go, it springs to the nearest. Greyed while Auto picks; touching it hands the choice back.
private struct EffortSlider: View {
    let levels: [Depth]
    let index: Int
    let dimmed: Bool
    let picked: (Int) -> Void
    @State private var dragging: CGFloat?
    @State private var stop: Int?

    var body: some View {
        VStack(spacing: 10) {
            HStack {
                Text("Faster")
                Spacer()
                Text("Smarter")
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Palette.muted)
            GeometryReader { box in
                let knob = CGSize(width: 22, height: 30)
                let left = knob.width / 2 + 2
                let right = box.size.width - knob.width / 2 - 2
                let span = CGFloat(max(levels.count - 1, 1))
                let at = dragging ?? CGFloat(index)
                let x = left + (right - left) * at / span
                let mid: CGFloat = 17
                ZStack(alignment: .topLeading) {
                    Capsule()
                        .fill(Palette.hover)
                        .frame(width: box.size.width, height: 10)
                        .position(x: box.size.width / 2, y: mid)
                    Capsule()
                        .fill(dimmed ? Palette.muted.opacity(0.6) : Palette.accent)
                        .frame(width: max(x + 4, 10), height: 10)
                        .position(x: max(x + 4, 10) / 2, y: mid)
                    ForEach(0..<levels.count, id: \.self) { i in
                        Circle()
                            .fill(CGFloat(i) <= at ? Color.white.opacity(0.75) : Palette.muted.opacity(0.7))
                            .frame(width: 4, height: 4)
                            .position(x: left + (right - left) * CGFloat(i) / span, y: mid)
                    }
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.white)
                        .frame(width: knob.width, height: knob.height)
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Palette.borderStrong.opacity(0.6), lineWidth: 0.5))
                        .shadow(color: .black.opacity(0.18), radius: 4, y: 2)
                        .scaleEffect(dragging == nil ? 1 : 1.08)
                        .position(x: x, y: mid)
                    // Each depth's name under its stop; the end ones flush with the track's ends.
                    ForEach(levels.indices, id: \.self) { i in
                        let first = i == 0
                        let end = i == levels.count - 1
                        Text(levels[i].label)
                            .font(.system(size: 11.5, weight: i == index && !dimmed ? .semibold : .regular))
                            .foregroundStyle(i == index && !dimmed ? Palette.text : Palette.muted)
                            .frame(width: 64, alignment: first ? .leading : end ? .trailing : .center)
                            .position(x: first ? 32 : end ? box.size.width - 32 : left + (right - left) * CGFloat(i) / span, y: 48)
                    }
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { drag in
                            let f = min(max((drag.location.x - left) / max(right - left, 1) * span, 0), span)
                            dragging = f
                            let near = Int(f.rounded())
                            if near != stop {
                                if stop != nil { Haptics.pick() }
                                stop = near
                            }
                        }
                        .onEnded { drag in
                            let f = min(max((drag.location.x - left) / max(right - left, 1) * span, 0), span)
                            let near = Int(f.rounded())
                            Haptics.pick()
                            picked(near)
                            withAnimation(.spring(response: 0.32, dampingFraction: 0.72)) { dragging = nil }
                            stop = nil
                        }
                )
            }
            .frame(height: 58)
        }
        .animation(.spring(response: 0.32, dampingFraction: 0.72), value: index)
        .accessibilityElement()
        .accessibilityLabel("Effort")
        .accessibilityValue(dimmed ? "Auto" : levels[min(index, levels.count - 1)].label)
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: picked(min(index + 1, levels.count - 1))
            case .decrement: picked(max(index - 1, 0))
            @unknown default: break
            }
        }
        .accessibilityIdentifier("effort-slider")
    }
}
