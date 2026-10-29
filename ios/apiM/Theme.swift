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
/// two take turns.
struct Mark: UIViewRepresentable {
    var size: CGFloat = 44
    var bouncing = false

    func makeUIView(context: Context) -> MarkView { MarkView() }

    func updateUIView(_ view: MarkView, context: Context) {
        view.set(size: size, bouncing: bouncing)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MarkView, context: Context) -> CGSize? {
        CGSize(width: size, height: size * 0.5)
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
struct Skeleton: UIViewRepresentable {
    var radius: CGFloat = 12

    func makeUIView(context: Context) -> SkeletonView { SkeletonView() }

    func updateUIView(_ view: SkeletonView, context: Context) {
        view.set(radius: radius)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: SkeletonView, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 120, height: proposal.height ?? 14)
    }
}

/// "Thinking" with a light running through the letters while it lasts.
struct ShimmerText: View {
    let text: String
    var active = true

    var body: some View {
        if active {
            Shimmer(text: text)
        } else {
            Text(text)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Palette.text2)
        }
    }
}

private struct Shimmer: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> ShimmerView { ShimmerView() }

    func updateUIView(_ view: ShimmerView, context: Context) {
        view.set(text: text)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ShimmerView, context: Context) -> CGSize? {
        uiView.base.intrinsicContentSize
    }
}

// MARK: - endless motion

/// Motion that lasts as long as its view, run by Core Animation. A SwiftUI animation that never ends redraws its view
/// on the main thread every frame and rebuilds the accessibility tree as often (the UI tests' queries never finished
/// while one was on screen); these cost the main thread nothing once started.
class Looping: UIView {
    private var laidOut = CGSize.zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: Looping, _: UITraitCollection) in view.paint() }
        // Core Animation drops a layer's animations while the app is away.
        NotificationCenter.default.addObserver(self, selector: #selector(restart), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.size != laidOut else { return }
        laidOut = bounds.size
        restart()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { restart() }
    }

    @objc func restart() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        paint()
        place()
        CATransaction.commit()
        animate()
    }

    /// Colours, again whenever light and dark change: a layer's colour does not follow them on its own.
    func paint() {}
    func place() {}
    func animate() {}

    func color(_ color: Color, alpha: CGFloat = 1) -> CGColor {
        UIColor(color).resolvedColor(with: traitCollection).withAlphaComponent(alpha).cgColor
    }

    static func forever(_ animation: CAAnimation, duration: CFTimeInterval) -> CAAnimation {
        animation.duration = duration
        animation.repeatCount = .infinity
        animation.isRemovedOnCompletion = false
        return animation
    }
}

final class MarkView: Looping {
    private let dots = (0..<3).map { _ in CALayer() }
    private var size: CGFloat = 44
    private var bouncing = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        dots.forEach(layer.addSublayer)
        isAccessibilityElement = false
        accessibilityElementsHidden = true
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    func set(size: CGFloat, bouncing: Bool) {
        guard size != self.size || bouncing != self.bouncing else { return }
        self.size = size
        self.bouncing = bouncing
        restart()
    }

    override func paint() {
        dots.forEach { $0.backgroundColor = color(Palette.accent) }
    }

    override func place() {
        let side = size * 0.26, gap = size * 0.08
        let left = (bounds.width - side * 3 - gap * 2) / 2
        for (i, dot) in dots.enumerated() {
            dot.bounds = CGRect(x: 0, y: 0, width: side, height: side)
            dot.cornerRadius = side / 2
            dot.position = CGPoint(x: left + side / 2 + CGFloat(i) * (side + gap), y: bounds.midY)
            dot.transform = CATransform3DMakeTranslation(0, i == 1 ? -size * 0.09 : 0, 0)
        }
    }

    override func animate() {
        for (i, dot) in dots.enumerated() {
            dot.removeAllAnimations()
            guard bouncing else { continue }
            let hop = CABasicAnimation(keyPath: "transform.translation.y")
            hop.fromValue = i == 1 ? -size * 0.09 : 0
            hop.toValue = i == 1 ? 0 : -size * 0.09
            hop.autoreverses = true
            hop.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            dot.add(Looping.forever(hop, duration: 0.55), forKey: "hop")
        }
    }
}

final class DotsView: Looping {
    private let dots = (0..<3).map { _ in CALayer() }
    private var size: CGFloat = 6

    override init(frame: CGRect) {
        super.init(frame: frame)
        dots.forEach(layer.addSublayer)
        isAccessibilityElement = false
        accessibilityElementsHidden = true
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    func set(size: CGFloat) {
        guard size != self.size else { return }
        self.size = size
        restart()
    }

    override func paint() {
        dots.forEach { $0.backgroundColor = color(Palette.accent) }
    }

    override func place() {
        for (i, dot) in dots.enumerated() {
            dot.bounds = CGRect(x: 0, y: 0, width: size, height: size)
            dot.cornerRadius = size / 2
            dot.position = CGPoint(x: size / 2 + CGFloat(i) * size * 1.7, y: bounds.midY)
            dot.opacity = 0.35
        }
    }

    override func animate() {
        let now = CACurrentMediaTime()
        let ease = CAMediaTimingFunction(name: .easeInEaseOut)
        for (i, dot) in dots.enumerated() {
            dot.removeAllAnimations()
            // Up and back in the first half of each 1.26 s, still in the second; each dot a little after the last.
            let rise = CAKeyframeAnimation(keyPath: "transform.translation.y")
            rise.values = [0, -size * 0.45, 0, 0]
            let glow = CAKeyframeAnimation(keyPath: "opacity")
            glow.values = [0.35, 1, 0.35, 0.35]
            for part in [rise, glow] {
                part.duration = 1.26
                part.keyTimes = [0, 0.25, 0.5, 1]
                part.timingFunctions = [ease, ease, CAMediaTimingFunction(name: .linear)]
            }
            let wave = CAAnimationGroup()
            wave.animations = [rise, glow]
            wave.beginTime = now + Double(i) * 0.16
            wave.fillMode = .backwards
            dot.add(Looping.forever(wave, duration: 1.26), forKey: "wave")
        }
    }
}

final class SkeletonView: Looping {
    private let shine = CAGradientLayer()
    private var radius: CGFloat = 12

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.masksToBounds = true
        layer.cornerCurve = .continuous
        shine.startPoint = CGPoint(x: 0, y: 0.5)
        shine.endPoint = CGPoint(x: 1, y: 0.5)
        layer.addSublayer(shine)
        isAccessibilityElement = false
        accessibilityElementsHidden = true
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    func set(radius: CGFloat) {
        guard radius != self.radius else { return }
        self.radius = radius
        layer.cornerRadius = radius
    }

    override func paint() {
        layer.backgroundColor = color(Palette.hover, alpha: 0.75)
        shine.colors = [color(Palette.surface, alpha: 0), color(Palette.surface, alpha: 0.55), color(Palette.surface, alpha: 0)]
    }

    override func place() {
        layer.cornerRadius = radius
        shine.frame = CGRect(x: 0, y: 0, width: bounds.width * 0.55, height: bounds.height)
    }

    override func animate() {
        shine.removeAllAnimations()
        let sweep = CABasicAnimation(keyPath: "transform.translation.x")
        sweep.fromValue = -bounds.width * 0.55
        sweep.toValue = bounds.width * 1.05
        shine.add(Looping.forever(sweep, duration: 1.4), forKey: "sweep")
    }
}

/// The words twice: dim, and bright under a band that runs across them.
final class ShimmerView: Looping {
    let base = UILabel()
    private let lit = UILabel()
    private let band = CAGradientLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        for label in [base, lit] {
            label.font = .systemFont(ofSize: 14, weight: .medium)
            addSubview(label)
        }
        base.textColor = UIColor(Palette.muted)
        lit.textColor = UIColor(Palette.text)
        band.startPoint = CGPoint(x: 0, y: 0.5)
        band.endPoint = CGPoint(x: 1, y: 0.5)
        band.colors = [UIColor.clear.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
        lit.layer.mask = band
        isAccessibilityElement = true
        accessibilityTraits = .staticText
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    func set(text: String) {
        guard text != base.text else { return }
        base.text = text
        lit.text = text
        accessibilityLabel = text
        invalidateIntrinsicContentSize()
    }

    override func place() {
        base.frame = bounds
        lit.frame = bounds
        band.frame = CGRect(x: 0, y: 0, width: bounds.width * 0.44, height: bounds.height)
    }

    override func animate() {
        band.removeAllAnimations()
        let run = CABasicAnimation(keyPath: "transform.translation.x")
        run.fromValue = -bounds.width * 0.52
        run.toValue = bounds.width * 1.08
        band.add(Looping.forever(run, duration: 1.8), forKey: "run")
    }
}
