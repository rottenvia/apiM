import ImageIO
import SwiftUI
import UIKit

/// The pictures in the chat: asked of the computer once, when they come into view, and decoded off the main thread
/// into a thumbnail for the transcript and the full picture for the viewer.
@Observable
final class Images {
    static let shared = Images()

    struct Ready {
        let id: String
        let thumb: UIImage?
        let full: UIImage?
    }

    private(set) var thumbs: [String: UIImage] = [:]
    private(set) var fulls: [String: UIImage] = [:]
    /// Asked for, and the computer had nothing to send (the file is gone).
    private(set) var missing: Set<String> = []
    @ObservationIgnored private var askedAt: [String: Date] = [:]
    @ObservationIgnored private var waitingFor: Set<String> = []
    @ObservationIgnored private var order: [String] = []

    /// Not here, and not asked for in the last few seconds (an answer lost to a dropped link is asked for again).
    func needs(_ id: String) -> Bool {
        guard thumbs[id] == nil, !missing.contains(id) else { return false }
        return askedAt[id].map { Date().timeIntervalSince($0) > 10 } ?? true
    }

    func asked(_ id: String) {
        askedAt[id] = Date()
        waitingFor.remove(id)
    }

    /// To ask for once the link is up.
    func wait(_ id: String) {
        waitingFor.insert(id)
    }

    func waiting() -> [String] {
        Array(waitingFor)
    }

    /// A picture picked on this phone, shown and opened like any other before it is sent.
    func keep(_ id: String, image: UIImage) {
        put(Ready(id: id, thumb: image, full: image))
    }

    func put(_ ready: Ready) {
        guard let thumb = ready.thumb else {
            missing.insert(ready.id)
            return
        }
        withAnimation(.easeOut(duration: 0.25)) {
            thumbs[ready.id] = thumb
            fulls[ready.id] = ready.full ?? thumb
        }
        order.append(ready.id)
        // ponytail: the 40 newest full pictures stay decoded; the rest keep their thumbnail and are asked for again.
        if order.count > 40 {
            let old = order.removeFirst()
            fulls[old] = nil
            thumbs[old] = nil
            askedAt[old] = nil
        }
    }

    /// Off the main thread: the base64 a frame carried, as a thumbnail the transcript can draw at once and the whole
    /// picture already decoded for the viewer.
    static func prepare(id: String, base64: String?) -> Ready {
        guard let base64, let data = Data(base64Encoded: base64) else { return Ready(id: id, thumb: nil, full: nil) }
        return decode(id: id, data: data)
    }

    static func decode(id: String, data: Data) -> Ready {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return Ready(id: id, thumb: nil, full: nil) }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: 900,
        ]
        let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
        let full = UIImage(data: data)?.preparingForDisplay()
        return Ready(id: id, thumb: thumb ?? full, full: full ?? thumb)
    }
}

extension EnvironmentValues {
    /// Where a picture's zoom into the viewer starts from: the thumbnail tapped.
    @Entry var zoomSpace: Namespace.ID? = nil
}

extension View {
    /// The source of the viewer's zoom, when there is a namespace for it.
    @ViewBuilder
    func zoomSource(_ id: String, in space: Namespace.ID?) -> some View {
        if let space {
            matchedTransitionSource(id: id, in: space)
        } else {
            self
        }
    }
}

/// A picture in the transcript: a shimmer until it arrives, then the thumbnail, which opens the viewer.
struct Thumbnail: View {
    let picture: Picture
    var width: CGFloat?
    var height: CGFloat
    var radius: CGFloat = 14
    @Environment(Remote.self) private var remote
    @Environment(Screen.self) private var screen
    @Environment(\.zoomSpace) private var space

    var body: some View {
        let images = Images.shared
        let thumb = images.thumbs[picture.id]
        ZStack {
            if let thumb {
                Image(uiImage: thumb)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            } else if images.missing.contains(picture.id) {
                VStack(spacing: 6) {
                    Image(systemName: "photo.badge.exclamationmark")
                        .font(.system(size: 20))
                    Text("Not on \(remote.name) anymore")
                        .font(.system(size: 11.5))
                        .multilineTextAlignment(.center)
                }
                .foregroundStyle(Palette.muted)
                .padding(8)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Palette.hover.opacity(0.6))
            } else {
                Skeleton(radius: radius)
            }
        }
        .frame(width: width, height: height)
        .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(Palette.border, lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .zoomSource(picture.id, in: space)
        .onTapGesture {
            guard thumb != nil else { return }
            Haptics.tap()
            screen.viewer = picture
        }
        .task(id: picture.id) { remote.image(picture.id) }
        .accessibilityElement()
        .accessibilityLabel(picture.name.isEmpty ? "Picture" : picture.name)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("picture")
    }
}

/// A picture full screen: pinch or double-tap to zoom, swipe down or Close to go back, Share to save or send it.
struct ImageViewer: View {
    let picture: Picture
    @Environment(\.dismiss) private var dismiss
    @State private var chrome = true

    var body: some View {
        let images = Images.shared
        let image = images.fulls[picture.id] ?? images.thumbs[picture.id]
        ZStack {
            Color.black.ignoresSafeArea()
            if let image {
                ZoomableImage(image: image) {
                    withAnimation(.easeInOut(duration: 0.2)) { chrome.toggle() }
                }
                .ignoresSafeArea()
            } else {
                ProgressView().tint(.white)
            }
        }
        .overlay(alignment: .top) {
            if chrome {
                HStack(spacing: 12) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .buttonStyle(Press())
                    .accessibilityLabel("Close")
                    Spacer(minLength: 0)
                    Text(picture.name)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.white.opacity(0.85))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                    if let image {
                        ShareLink(item: Image(uiImage: image), preview: SharePreview(picture.name.isEmpty ? "Picture" : picture.name, image: Image(uiImage: image))) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(width: 40, height: 40)
                                .background(.ultraThinMaterial, in: Circle())
                        }
                        .buttonStyle(Press())
                        .accessibilityLabel("Share")
                    } else {
                        Color.clear.frame(width: 40, height: 40)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .transition(.opacity)
            }
        }
        .statusBarHidden(!chrome)
        .accessibilityIdentifier("viewer")
    }
}

/// A UIScrollView around the picture: pinch, double-tap and pan behave as in Photos.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    let tapped: () -> Void

    func makeUIView(context: Context) -> ZoomView {
        let view = ZoomView(image: image)
        view.tapped = tapped
        return view
    }

    func updateUIView(_ view: ZoomView, context: Context) {
        view.tapped = tapped
        if view.imageView.image !== image {
            // The thumbnail first, then the full picture once decoded: same size on screen, sharper.
            view.imageView.image = image
        }
    }
}

final class ZoomView: UIScrollView, UIScrollViewDelegate {
    let imageView: UIImageView
    var tapped: (() -> Void)?
    private var fitted = CGSize.zero

    init(image: UIImage) {
        imageView = UIImageView(image: image)
        super.init(frame: .zero)
        imageView.contentMode = .scaleAspectFit
        addSubview(imageView)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 5
        bouncesZoom = true
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        decelerationRate = .fast
        backgroundColor = .clear
        let double = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        double.numberOfTapsRequired = 2
        addGestureRecognizer(double)
        let single = UITapGestureRecognizer(target: self, action: #selector(singleTapped))
        single.require(toFail: double)
        addGestureRecognizer(single)
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.size != fitted, zoomScale == minimumZoomScale, let size = imageView.image?.size, size.width > 0, size.height > 0 else { return }
        fitted = bounds.size
        let scale = min(bounds.width / size.width, bounds.height / size.height)
        let shown = CGSize(width: size.width * scale, height: size.height * scale)
        imageView.frame = CGRect(origin: .zero, size: shown)
        contentSize = shown
        center()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) { center() }

    /// Smaller than the screen on a side, the picture sits in the middle of it.
    private func center() {
        let dx = max(0, (bounds.width - contentSize.width) / 2)
        let dy = max(0, (bounds.height - contentSize.height) / 2)
        contentInset = UIEdgeInsets(top: dy, left: dx, bottom: dy, right: dx)
    }

    @objc private func singleTapped() { tapped?() }

    @objc private func doubleTapped(_ tap: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale {
            setZoomScale(minimumZoomScale, animated: true)
        } else {
            let at = tap.location(in: imageView)
            let scale: CGFloat = 2.5
            let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
            zoom(to: CGRect(x: at.x - size.width / 2, y: at.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }
}
