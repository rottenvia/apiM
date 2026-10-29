import SwiftUI
import UIKit

/// apiM's palette: the desktop's own dark theme (`desktop/assets/themes.json`, "apiM"), and a warm paper light one
/// beside it. Every colour follows the phone's light/dark setting.
enum Palette {
    static let bg = dynamic(light: 0xFAF9F5, dark: 0x191715)
    /// The drawer and sheets: a step away from the page.
    static let bg2 = dynamic(light: 0xF3F1EA, dark: 0x141210)
    /// Cards, the message box, a tool step's box.
    static let surface = dynamic(light: 0xFFFFFF, dark: 0x22201D)
    static let elevated = dynamic(light: 0xFFFFFF, dark: 0x2A2723)
    static let userBubble = dynamic(light: 0xEFEBE1, dark: 0x302C27)
    static let hover = dynamic(light: 0xEAE6DC, dark: 0x33302A)
    static let border = dynamic(light: 0xE4E0D6, dark: 0x2E2A25)
    static let borderStrong = dynamic(light: 0xD3CEC2, dark: 0x403C34)
    static let text = dynamic(light: 0x1F1D1A, dark: 0xEDE9E2)
    static let text2 = dynamic(light: 0x5F5B53, dark: 0xA29D92)
    static let muted = dynamic(light: 0x8E897E, dark: 0x6D685D)
    static let accent = dynamic(light: 0xC2603E, dark: 0xD0714F)
    static let accentSoft = dynamic(light: 0xF6E3DA, dark: 0x3A2620)
    static let success = dynamic(light: 0x4E8A4B, dark: 0x7BA478)
    static let warning = dynamic(light: 0xB07D2B, dark: 0xCFA25A)
    static let danger = dynamic(light: 0xB9473C, dark: 0xCF6A5F)
    static let code = dynamic(light: 0xF4F1EA, dark: 0x1E1C19)

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// The type: prose from the model is set in a serif, like Claude's replies; everything the app says is the system sans.
enum Typeface {
    static let body = Font.system(size: 16)
    static let mono = Font.system(size: 13, design: .monospaced)
    static let small = Font.system(size: 13)
    static let tiny = Font.system(size: 11.5)

    /// The size replies are set in: Settings › Text size (`textSize`, 0 to 2).
    static var proseSize: CGFloat {
        [15.5, 17, 19][min(max(UserDefaults.standard.integer(forKey: "textSize"), 0), 2)]
    }

    /// The phone's own settings before the user touches them.
    static func registerDefaults() {
        UserDefaults.standard.register(defaults: ["textSize": 1, "haptics": true, "appearance": 0])
    }
}

/// Taps the app answers with, all off at once in Settings › Haptics.
enum Haptics {
    private static var on: Bool { UserDefaults.standard.bool(forKey: "haptics") }

    static func tap() {
        guard on else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func press() {
        guard on else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    static func pick() {
        guard on else { return }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    static func success() {
        guard on else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func warn() {
        guard on else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}

/// The mark from the desktop's icon: three dots, the middle one mid-bounce. Bouncing, the middle one and the outer
/// two take turns; the timeline stops when it stops, so a still mark costs nothing.
struct Mark: View {
    var size: CGFloat = 44
    var bouncing = false

    var body: some View {
        TimelineView(.animation(paused: !bouncing)) { context in
            // 0 to 1 and back every 1.1 s, eased at both ends as the spring it replaces was.
            let wave = bouncing ? (1 - cos(context.date.timeIntervalSinceReferenceDate * .pi / 0.55)) / 2 : 1
            HStack(spacing: size * 0.08) {
                ForEach(0..<3) { i in
                    Circle()
                        .fill(Palette.accent)
                        .frame(width: size * 0.26, height: size * 0.26)
                        .offset(y: -size * 0.09 * (i == 1 ? wave : 1 - wave))
                }
            }
        }
        .frame(width: size, height: size * 0.5)
        .accessibilityHidden(true)
    }
}

/// Shrinks under the finger and springs back: every tappable thing in the app answers the same way.
struct Press: ButtonStyle {
    var scale: CGFloat = 0.92

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.65), value: configuration.isPressed)
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
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.7), value: configuration.isPressed)
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
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// A placeholder with a light passing over it, for what is on its way.
struct Skeleton: View {
    var radius: CGFloat = 12

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.4) / 1.4
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(Palette.hover.opacity(0.75))
                .overlay {
                    GeometryReader { box in
                        LinearGradient(colors: [.clear, Palette.surface.opacity(0.55), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: box.size.width * 0.55)
                            .offset(x: (t * 1.6 - 0.55) * box.size.width)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        }
        // Redrawn every frame: out of the accessibility tree, which would be rebuilt as often (and UI tests wait on it).
        .accessibilityHidden(true)
    }
}

/// "Thinking" with a light running through the letters while it lasts.
struct ShimmerText: View {
    let text: String
    var font: Font = .system(size: 14, weight: .medium)
    var active = true

    var body: some View {
        if active {
            TimelineView(.animation) { context in
                let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.8) / 1.8
                let at = t * 1.6 - 0.3
                let clamp = { (x: Double) in min(max(x, 0), 1) }
                Text(text)
                    .font(font)
                    .foregroundStyle(LinearGradient(stops: [
                        .init(color: Palette.muted, location: 0),
                        .init(color: Palette.muted, location: clamp(at - 0.22)),
                        .init(color: Palette.text, location: clamp(at)),
                        .init(color: Palette.muted, location: clamp(at + 0.22)),
                        .init(color: Palette.muted, location: 1),
                    ], startPoint: .leading, endPoint: .trailing))
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(text)
        } else {
            Text(text)
                .font(font)
                .foregroundStyle(Palette.text2)
        }
    }
}
