import Foundation
import Network
import Observation
import UIKit

/// The link to apiM on the computer, and everything it last said. All of it lives on the main thread: the
/// connection delivers there, and the views read it there.
@Observable
final class Remote {
    enum Phase: Equatable {
        case unpaired
        case connecting
        case online
    }

    private(set) var pairing: Pairing?
    private(set) var phase: Phase = .unpaired
    /// Why the last connection failed, shown while the next one is tried. Nil once online.
    private(set) var problem: String?
    private(set) var pc = ""
    private(set) var model = ""
    private(set) var chats: [ChatRow] = []
    private(set) var chat = ChatState()
    private(set) var run = RunState()
    /// A chat asked for from the list, until the computer has it on screen.
    private(set) var opening: String?
    /// The words just sent, shown at once until the computer's copy of them arrives.
    private(set) var sending: String?
    /// The computer's latest notice (a message that was not sent says why), shown as a banner until dismissed.
    var banner: String?

    @ObservationIgnored private var connection: NWConnection?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var buffer = Data()
    @ObservationIgnored private var sealer: Sealer?
    @ObservationIgnored private var mine = Data()
    @ObservationIgnored private var heard = Date()
    @ObservationIgnored private var opened = false
    @ObservationIgnored private var pinger: Timer?
    @ObservationIgnored private var retry: DispatchWorkItem?
    @ObservationIgnored private var failures = 0
    @ObservationIgnored private var lastNotice = ""
    @ObservationIgnored private var active = true

    init() {
        let process = ProcessInfo.processInfo
        if process.arguments.contains("-reset") {
            Keychain.clear()
        }
        // The UI tests pair with their test server this way; nothing else sets it.
        if let link = process.environment["APIM_PAIR"], let pairing = Pairing(link: link) {
            self.pairing = pairing
        } else {
            pairing = Keychain.load()
        }
        phase = pairing == nil ? .unpaired : .connecting
    }

    var name: String { pc.isEmpty ? (pairing?.name ?? "your PC") : pc }

    // MARK: pairing

    /// Pairs with the computer a scanned or pasted link names. False when the link is not one.
    @discardableResult
    func pair(_ link: String) -> Bool {
        guard let pairing = Pairing(link: link) else { return false }
        Keychain.save(pairing)
        self.pairing = pairing
        forget()
        failures = 0
        connect()
        return true
    }

    func unpair() {
        disconnect()
        Keychain.clear()
        pairing = nil
        phase = .unpaired
        forget()
    }

    /// Drops everything the last computer said.
    private func forget() {
        pc = ""
        model = ""
        chats = []
        chat = ChatState()
        run = RunState()
        problem = nil
        opening = nil
        sending = nil
        banner = nil
    }

    /// The app came to the front or went behind: iOS suspends a connection in the background anyway, so it is closed
    /// there and opened again on return.
    func setActive(_ on: Bool) {
        // Asked twice at launch (the first appearance and the scene turning active): the second finds it under way.
        if on, active, connection != nil { return }
        active = on
        if on {
            failures = 0
            connect()
        } else {
            disconnect()
            if pairing != nil { phase = .connecting }
        }
    }

    // MARK: asking the computer

    func open(_ id: String) {
        guard id != chat.id else { return }
        opening = id
        send(["t": "open", "id": id])
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            if self?.opening == id { self?.opening = nil }
        }
    }

    func newChat() {
        send(["t": "new"])
    }

    func stop() {
        send(["t": "stop"])
    }

    func allow(_ yes: Bool) {
        send(["t": "allow", "allow": yes])
        run.approval = nil
    }

    func answer(_ text: String) {
        send(["t": "answer", "text": text])
        run.question = nil
    }

    /// Sends a message as if typed into apiM's own box. While a reply runs, it reads it as a note.
    func say(_ text: String, photos: [Data]) {
        let list = photos.enumerated().map { ["name": "photo-\($0.offset + 1)", "data": $0.element.base64EncodedString()] }
        send(["t": "send", "text": text, "photos": list])
        sending = text.isEmpty ? (photos.isEmpty ? nil : "Photo") : text
        // A message the computer would not send (no key, a picture still being read) never comes back: its notice does.
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            if self?.sending == text { self?.sending = nil }
        }
    }

    // MARK: the connection

    func connect() {
        guard let pairing, active else { return }
        disconnect()
        phase = .connecting
        attempt(host: 0, pairing: pairing, generation: generation)
    }

    private func disconnect() {
        retry?.cancel()
        retry = nil
        pinger?.invalidate()
        pinger = nil
        // Whatever the old connection still reports is ignored from here on.
        generation += 1
        connection?.cancel()
        connection = nil
        sealer = nil
        buffer = Data()
        opened = false
    }

    /// Tries each of the computer's addresses in turn: the home network's first, then Tailscale's.
    private func attempt(host index: Int, pairing: Pairing, generation: Int) {
        guard index < pairing.hosts.count, let port = NWEndpoint.Port(rawValue: pairing.port) else {
            return lost("No address to reach \(name) at. Scan the code in apiM again.")
        }
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = 5
        tcp.noDelay = true
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 10
        let connection = NWConnection(host: NWEndpoint.Host(pairing.hosts[index]), port: port, using: NWParameters(tls: nil, tcp: tcp))
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            DispatchQueue.main.async {
                guard let self, generation == self.generation else { return }
                switch state {
                case .ready:
                    self.mine = Data.random(16)
                    let hello: [String: Any] = ["v": 1, "nonce": self.mine.base64URL, "name": UIDevice.current.name]
                    self.write((try? JSONSerialization.data(withJSONObject: hello)) ?? Data())
                    self.heard = Date()
                    self.receive(connection, generation)
                case .waiting(let error), .failed(let error):
                    connection.stateUpdateHandler = nil
                    connection.cancel()
                    if index + 1 < pairing.hosts.count {
                        self.attempt(host: index + 1, pairing: pairing, generation: generation)
                    } else {
                        self.lost(self.explain(error))
                    }
                default:
                    break
                }
            }
        }
        connection.start(queue: .main)
    }

    private func receive(_ connection: NWConnection, _ generation: Int) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, complete, error in
            DispatchQueue.main.async {
                guard let self, generation == self.generation else { return }
                if let data, !data.isEmpty {
                    self.buffer.append(data)
                    guard let frames = Frames.take(from: &self.buffer) else { return self.lost("The connection to \(self.name) broke.") }
                    for frame in frames {
                        self.handle(frame)
                        if generation != self.generation { return }
                    }
                }
                if complete || error != nil {
                    // Dropped right after the first sealed frame: the computer could not open it, so its key is not ours.
                    self.lost(self.sealer != nil && !self.opened
                        ? "apiM on \(self.name) did not accept this phone: it was unpaired there. Scan the code in Settings › Phone again."
                        : "\(self.name) closed the connection.")
                } else {
                    self.receive(connection, generation)
                }
            }
        }
    }

    private func handle(_ frame: Data) {
        heard = Date()
        guard sealer != nil else {
            guard let hello = try? JSONSerialization.jsonObject(with: frame) as? [String: Any],
                  let nonce = hello["nonce"] as? String, let theirs = Data(base64URL: nonce), theirs.count == 16,
                  let pairing else { return lost("Something other than apiM answered at \(name).") }
            sealer = Sealer(secret: pairing.secret, phone: mine, pc: theirs)
            send(["t": "ping"])
            return
        }
        guard let plain = try? sealer!.open(frame) else { return lost("A message from \(name) did not decrypt.") }
        if !opened {
            opened = true
            failures = 0
            problem = nil
            phase = .online
            pinger = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.ping() }
        }
        guard let object = try? JSONSerialization.jsonObject(with: plain) as? [String: Any], object["t"] as? String == "state" else { return }
        if let patch = try? JSONDecoder().decode(Patch.self, from: plain) {
            apply(patch)
        }
    }

    private func ping() {
        if Date().timeIntervalSince(heard) > 40 {
            return lost("\(name) stopped answering.")
        }
        send(["t": "ping"])
    }

    func apply(_ patch: Patch) {
        if let chats = patch.chats {
            self.chats = chats.sorted { $0.updated > $1.updated }
        }
        if let run = patch.run {
            self.run = run
        }
        if let top = patch.top {
            pc = top.pc
            model = top.model
            if top.notice != lastNotice {
                lastNotice = top.notice
                if !top.notice.isEmpty {
                    banner = top.notice
                    // The message the notice is about was not sent: its faded bubble goes.
                    sending = nil
                }
            }
        }
        if let patch = patch.chat {
            let before = chat.messages.count
            chat.apply(patch)
            if opening == chat.id { opening = nil }
            if patch.full || chat.messages.count > before { sending = nil }
        }
    }

    private func send(_ object: [String: Any]) {
        guard sealer != nil, let data = try? JSONSerialization.data(withJSONObject: object), let sealed = try? sealer!.seal(data) else { return }
        write(sealed)
    }

    private func write(_ payload: Data) {
        connection?.send(content: Frames.encode(payload), completion: .contentProcessed { _ in })
    }

    private func lost(_ reason: String) {
        disconnect()
        guard pairing != nil else { return }
        phase = .connecting
        problem = reason
        failures += 1
        guard active else { return }
        // 1, 2, 4, 8 then every 15 seconds: quick when the computer only blinked, quiet when it is off.
        let delay = min(15, pow(2, Double(failures - 1)))
        let item = DispatchWorkItem { [weak self] in self?.connect() }
        retry = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func explain(_ error: NWError) -> String {
        if case .posix(let code) = error {
            switch code {
            case .ECONNREFUSED:
                return "\(name) is there, but apiM is not listening. Open apiM on it and turn on Settings › Phone."
            case .ETIMEDOUT, .EHOSTUNREACH, .ENETUNREACH, .EHOSTDOWN, .ENETDOWN:
                return "Can't reach \(name). Check it is on and on the same Wi-Fi, and that apiM may use the network there."
            default:
                break
            }
        }
        return "Can't reach \(name): \(error.localizedDescription)"
    }
}
