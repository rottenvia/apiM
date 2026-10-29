import AVFoundation
import SwiftUI
import UIKit

/// The first screen: how to find the code in apiM on the computer, and the camera to scan it.
struct PairView: View {
    @Environment(Remote.self) private var remote
    @State private var scanning = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)
            Mark(size: 76)
            Text("apiM")
                .font(.system(size: 42, weight: .semibold, design: .serif))
                .foregroundStyle(Palette.text)
                .padding(.top, 22)
            Text("Your computer's apiM, in your pocket.")
                .font(.system(size: 17))
                .foregroundStyle(Palette.text2)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
            Spacer(minLength: 24)

            VStack(alignment: .leading, spacing: 16) {
                Step(number: 1, text: "Open apiM on your computer.")
                Step(number: 2, text: "Go to Settings › Phone and turn on Remote control.")
                Step(number: 3, text: "Scan the code it shows. The iPhone's Camera app works too.")
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Palette.border, lineWidth: 1))

            if let error {
                Text(error)
                    .font(.system(size: 14))
                    .foregroundStyle(Palette.danger)
                    .multilineTextAlignment(.center)
                    .padding(.top, 14)
                    .transition(.opacity)
            }

            Button {
                error = nil
                scanning = true
            } label: {
                Label("Scan code", systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(Primary())
            .padding(.top, 22)

            Button {
                guard let text = UIPasteboard.general.string, remote.pair(text) else {
                    withAnimation { error = "The clipboard holds no apiM pairing link. In apiM, use Copy pairing link under Settings › Phone." }
                    return
                }
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } label: {
                Text("Paste pairing link")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(Secondary())
            .padding(.top, 10)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 20)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.bg.ignoresSafeArea())
        .sheet(isPresented: $scanning) {
            ScanSheet { link in
                guard remote.pair(link) else { return false }
                scanning = false
                return true
            }
        }
    }
}

private struct Step: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Palette.accent)
                .frame(width: 24, height: 24)
                .background(Palette.accentSoft, in: Circle())
            Text(text)
                .font(.system(size: 15.5))
                .foregroundStyle(Palette.text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The camera, full screen, with a frame to aim the code into. `found` pairs and says whether it did.
struct ScanSheet: View {
    let found: (String) -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var problem: String?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let problem {
                VStack(spacing: 14) {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(.white.opacity(0.7))
                    Text(problem)
                        .font(.system(size: 16))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                    if problem.contains("Settings") {
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                        .buttonStyle(Primary())
                    }
                }
                .padding(32)
            } else {
                Scanner(found: { link in
                    if found(link) {
                        dismiss()
                    }
                }, failed: { problem = $0 })
                .ignoresSafeArea()
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .stroke(.white.opacity(0.9), lineWidth: 3)
                    .frame(width: 250, height: 250)
                    .shadow(color: .black.opacity(0.4), radius: 10)
                VStack {
                    Spacer()
                    Text("Point at the code in apiM › Settings › Phone")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(.black.opacity(0.55), in: Capsule())
                        .padding(.bottom, 60)
                }
            }
            VStack {
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(.black.opacity(0.5), in: Circle())
                    }
                    .accessibilityLabel("Close")
                    .padding(16)
                }
                Spacer()
            }
        }
    }
}

private struct Scanner: UIViewControllerRepresentable {
    let found: (String) -> Void
    let failed: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.found = found
        controller.failed = failed
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var found: ((String) -> Void)?
    var failed: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var done = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            setUp()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    if granted { self.setUp() } else { self.failed?(ScannerController.denied) }
                }
            }
        default:
            failed?(ScannerController.denied)
        }
    }

    static let denied = "apiM may not use the camera. Allow it in Settings, or paste the pairing link instead."

    private func setUp() {
        guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            failed?("No camera to scan with here. Use Paste pairing link instead.")
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            failed?("The camera cannot read codes right now. Use Paste pairing link instead.")
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        preview = layer
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async {
            if session.isRunning { session.stopRunning() }
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        // Any other code in view is passed over: only an apiM link stops the camera.
        guard !done, let code = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue, Pairing(link: code) != nil else { return }
        done = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        found?(code)
    }
}
