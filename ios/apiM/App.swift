import SwiftUI

@main
struct ApiMApp: App {
    @State private var remote: Remote
    @State private var screen = Screen()
    @AppStorage("appearance") private var appearance = 0
    @Environment(\.scenePhase) private var scene

    init() {
        Typeface.registerDefaults()
        _remote = State(initialValue: Remote())
    }

    var body: some Scene {
        WindowGroup {
            Root()
                .environment(remote)
                .environment(screen)
                .tint(Palette.accent)
                .preferredColorScheme(appearance == 1 ? .light : appearance == 2 ? .dark : nil)
                // The Camera app opens `apim://pair?...` straight into here.
                .onOpenURL { url in remote.pair(url.absoluteString) }
                .onChange(of: scene) { _, now in
                    if now == .active { remote.setActive(true) }
                    if now == .background { remote.setActive(false) }
                }
        }
    }
}

private struct Root: View {
    @Environment(Remote.self) private var remote

    var body: some View {
        ZStack {
            if remote.pairing == nil {
                PairView()
                    .transition(.opacity)
            } else {
                ChatScreen()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: remote.pairing == nil)
        .task { remote.setActive(true) }
    }
}
