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
    static let prose = Font.system(size: 17, weight: .regular, design: .serif)
    static let proseSize: CGFloat = 17
    static let body = Font.system(size: 16)
    static let mono = Font.system(size: 13, design: .monospaced)
    static let small = Font.system(size: 13)
    static let tiny = Font.system(size: 11.5)
}

/// The mark from the desktop's icon: three dots, the middle one mid-bounce.
struct Mark: View {
    var size: CGFloat = 44
    var bouncing = false
    @State private var phase = false

    var body: some View {
        HStack(spacing: size * 0.08) {
            ForEach(0..<3) { i in
                Circle()
                    .fill(Palette.accent)
                    .frame(width: size * 0.26, height: size * 0.26)
                    .offset(y: lift(i))
            }
        }
        .frame(width: size, height: size * 0.5)
        .onAppear {
            guard bouncing else { return }
            withAnimation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true)) { phase = true }
        }
    }

    private func lift(_ i: Int) -> CGFloat {
        if bouncing {
            return (phase == (i == 1)) ? -size * 0.09 : 0
        }
        return i == 1 ? -size * 0.09 : 0
    }
}
