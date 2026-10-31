import Foundation
import Network
import Observation
import os
import SwiftUI
import UIKit

/// The link to apiM on the computer, and everything it last said. The views read it on the main thread; what
/// arrives is decrypted there, but decoded, and its markdown and pictures laid out, on a queue of its own, so a
/// long chat or a big screenshot never holds up a scroll.
@Observable
final class Remote {
    enum Phase: Equatable {
        case unpaired
        case connecting
        case online
    }

    /// A photo or file going with a message: a photo's name has no extension and it is a JPEG.
    struct Outgoing {
        var name: String
        var data: Data
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
    private(set) var conf: Conf?
    private(set) var models: [ModelRow] = []
    /// A chat asked for from the list, until the computer has it on screen.
    private(set) var opening: String?
    /// The words just sent, shown at once until the computer's copy of them arrives.
    private(set) var sending: String?
    /// Older messages asked for and not here yet.
    private(set) var fetchingEarlier = false
    /// The computer's latest notice (a message that was not sent says why), shown as a banner until dismissed.
    var banner: String?
    /// The phone-lock toggle's position. Set from here; the guardian does not report it back, so it starts off each
    /// launch and shows the last thing this phone sent.
    var pcLocked = false

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
    @ObservationIgnored private let decoding = DispatchQueue(label: "apim.decode", qos: .userInitiated)
    /// The chats seen this session, by id, newest last: one opened again shows at once, then catches up.
    @ObservationIgnored private var cache: [String: ChatState] = [:]
    @ObservationIgnored private var cacheOrder: [String] = []
    @ObservationIgnored private var saving: DispatchWorkItem?
    /// When the chat on its way was asked for, for the log.
    @ObservationIgnored private var askedAt = Date()

    init() {
        let process = ProcessInfo.processInfo
        if process.arguments.contains("-reset") {
            Keychain.clear()
            Snapshot.clear()
        }
        // The UI tests pair with their test server this way; nothing else sets it.
        if let link = process.environment["APIM_PAIR"], let pairing = Pairing(link: link) {
            self.pairing = pairing
        } else {
            pairing = Keychain.load()
        }
        phase = pairing == nil ? .unpaired : .connecting
        if pairing != nil {
            Snapshot.load { [weak self] snapshot in
                guard let self, let snapshot, self.chats.isEmpty, self.chat.id.isEmpty else { return }
                self.pc = snapshot.pc
                self.model = snapshot.model
                self.chats = snapshot.chats
                self.chat = snapshot.chat
                self.conf = snapshot.conf
                self.models = snapshot.models
                self.remember(snapshot.chat)
            }
        }
    }

    /// What the link does, in the system log (Console, or `log stream --predicate 'subsystem == "com.rottenvia.apim"'`):
    /// never what is said over it.
    static let log = Logger(subsystem: "com.rottenvia.apim", category: "link")

    var name: String { pc.isEmpty ? (pairing?.name ?? "your PC") : pc }
    var online: Bool { phase == .online }

    /// The model in use as the model menu names it, short.
    var modelShort: String {
        guard let conf, let row = models.first(where: { $0.id == conf.model }) else { return model }
        return row.short.isEmpty ? row.label : row.short
    }

    // MARK: pairing

    /// Pairs with the computer a scanned or pasted link names. False when the link is not one.
    @discardableResult
    func pair(_ link: String) -> Bool {
        guard let pairing = Pairing(link: link) else { return false }
        Keychain.save(pairing)
        Snapshot.clear()
        self.pairing = pairing
        forget()
        failures = 0
        connect()
        return true
    }

    func unpair() {
        disconnect()
        Keychain.clear()
        Snapshot.clear()
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
        conf = nil
        models = []
        problem = nil
        opening = nil
        sending = nil
        banner = nil
        cache = [:]
        cacheOrder = []
    }

    /// The app came to the front or went behind: iOS suspends a connection in the background anyway, so it is closed
    /// there and opened again on return.
    func setActive(_ on: Bool) {
        // Asked twice at launch (the first appearance and the scene turning active): the second finds it under way.
        if on, active, connection != nil { return }
        Remote.log.notice("active \(on, privacy: .public)")
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

    /// Opens a chat here at once, from what was last seen of it, and on the computer.
    func open(_ id: String) {
        guard id != chat.id else { return }
        let row = chats.first { $0.id == id }
        let shown = cache[id] ?? ChatState(id: id, title: row?.title ?? "", earlier: 0, messages: [])
        // Marked as on its way before it is shown: its first frame is the loading shape, not the welcome of an
        // empty chat.
        if online {
            opening = id
            askedAt = Date()
        }
        withAnimation(.smooth(duration: 0.22)) { chat = shown }
        fetchingEarlier = false
        guard online else { return }
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
        withAnimation(.snappy) { run.approval = nil }
    }

    func answer(_ text: String) {
        send(["t": "answer", "text": text])
        withAnimation(.snappy) { run.question = nil }
    }

    /// Sends a message as if typed into apiM's own box. While a reply runs, it reads it as a note.
    func say(_ text: String, files: [Outgoing]) {
        let list = files.map { ["name": $0.name, "data": $0.data.base64EncodedString()] }
        send(["t": "send", "text": text, "photos": list])
        let shown = text.isEmpty ? (files.isEmpty ? nil : files.count == 1 ? "1 attachment" : "\(files.count) attachments") : text
        withAnimation(.snappy(duration: 0.3)) { sending = shown }
        // A message the computer would not send (no key, a picture still being read) never comes back: its notice does.
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            if self?.sending == shown { withAnimation { self?.sending = nil } }
        }
    }

    /// A setting, changed here at once and on the computer.
    func set(_ key: String, _ value: Any) {
        send(["t": "set", "key": key, "value": value])
        guard var conf else { return }
        switch key {
        case "model":
            if let id = value as? String {
                conf.model = id
                model = models.first { $0.id == id }?.label ?? model
            }
        case "effort": conf.effort = value as? String ?? conf.effort
        case "web": conf.web = value as? String ?? conf.web
        case "search": conf.search = value as? String ?? conf.search
        case "approval": conf.approval = value as? String ?? conf.approval
        case "computer": conf.computer = value as? Bool ?? conf.computer
        case "lessons": conf.lessons = value as? Bool ?? conf.lessons
        default: break
        }
        withAnimation(.snappy(duration: 0.25)) { self.conf = conf }
    }

    func rename(_ id: String, _ title: String) {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        send(["t": "rename", "id": id, "title": title])
        if let at = chats.firstIndex(where: { $0.id == id }) { chats[at].title = title }
        if chat.id == id { chat.title = title }
    }

    func archive(_ id: String, _ archived: Bool) {
        send(["t": "archive", "id": id, "archived": archived])
        if let at = chats.firstIndex(where: { $0.id == id }) {
            withAnimation(.snappy) { chats[at].archived = archived }
        }
    }

    func deleteChat(_ id: String) {
        send(["t": "delete_chat", "id": id])
        withAnimation(.snappy) { chats.removeAll { $0.id == id } }
        cache[id] = nil
    }

    /// Deletes a question and its reply, by the id of either.
    func delete(_ messageID: String) {
        send(["t": "delete", "id": messageID])
    }

    /// Asks a question again in other words: the replies after it go.
    func edit(_ messageID: String, _ text: String) {
        send(["t": "edit", "id": messageID, "text": text])
        withAnimation(.snappy(duration: 0.3)) { sending = text }
    }

    func regenerate() {
        send(["t": "retry"])
    }

    func resume() {
        send(["t": "resume"])
    }

    /// The chat's older messages, which the computer kept back.
    func more() {
        guard online, !fetchingEarlier, chat.earlier > 0 else { return }
        fetchingEarlier = true
        send(["t": "more"])
        let id = chat.id
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            if self?.chat.id == id { self?.fetchingEarlier = false }
        }
    }

    /// Asks for a picture's bytes, once; whatever is asked while offline goes when the link is back.
    func image(_ id: String) {
        let images = Images.shared
        guard images.needs(id) else { return }
        guard online else { return images.wait(id) }
        images.asked(id)
        send(["t": "image", "id": id])
    }

    // MARK: the connection

    func connect() {
        guard let pairing, active else { return }
        disconnect()
        phase = .connecting
        Remote.log.notice("connecting to \(pairing.hosts.count, privacy: .public) addresses")
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
        opening = nil
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
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
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
        // Opened here, in order: each frame's nonce is the next number.
        guard let plain = try? sealer!.open(frame) else { return lost("A message from \(name) did not decrypt.") }
        if !opened {
            opened = true
            Remote.log.notice("online")
            failures = 0
            problem = nil
            phase = .online
            pinger = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.ping() }
            for id in Images.shared.waiting() { image(id) }
        }
        // Everything else off this thread: a chat of a few MB decodes, and its markdown is laid out, while the
        // phone scrolls. One queue keeps the frames in order.
        let generation = self.generation
        let size = Typeface.proseSize
        decoding.async { [weak self] in
            guard let incoming = try? JSONDecoder().decode(Incoming.self, from: plain) else { return }
            let picture: Images.Ready?
            switch incoming.t {
            case "state":
                if let messages = incoming.chat?.messages { Prose.warm(messages, size: size) }
                picture = nil
            case "image":
                guard let id = incoming.id else { return }
                picture = Images.prepare(id: id, base64: incoming.data)
            default:
                return
            }
            DispatchQueue.main.async {
                guard let self, generation == self.generation else { return }
                Remote.log.debug("frame \(incoming.t, privacy: .public): \(plain.count, privacy: .public) bytes, \(incoming.chat?.messages.count ?? -1, privacy: .public) messages")
                if let picture {
                    Images.shared.put(picture)
                } else {
                    self.apply(incoming)
                }
            }
        }
    }

    private func ping() {
        if Date().timeIntervalSince(heard) > 40 {
            return lost("\(name) stopped answering.")
        }
        send(["t": "ping"])
    }

    func apply(_ patch: Incoming) {
        if let chats = patch.chats {
            let sorted = chats.sorted { $0.updated > $1.updated }
            if sorted != self.chats {
                withAnimation(.snappy(duration: 0.3)) { self.chats = sorted }
            }
        }
        if let run = patch.run, run != self.run {
            let asked = run.approval != nil && self.run.approval == nil
            let finished = self.run.running && !run.running
            withAnimation(.snappy(duration: 0.32)) { self.run = run }
            if asked { Haptics.warn() }
            if finished { Haptics.tap() }
        }
        if let conf = patch.conf, conf != self.conf {
            withAnimation(.snappy(duration: 0.25)) { self.conf = conf }
        }
        if let models = patch.models, models != self.models {
            self.models = models
        }
        if let top = patch.top {
            if pc != top.pc { pc = top.pc }
            if model != top.model { model = top.model }
            if top.notice != lastNotice {
                lastNotice = top.notice
                if !top.notice.isEmpty {
                    banner = top.notice
                    // The message the notice is about was not sent: its faded bubble goes.
                    sending = nil
                    Haptics.warn()
                }
            }
        }
        if let patch = patch.chat {
            take(patch)
        }
        keep()
    }

    /// A chat as the computer has it now. Shown unless another one was asked for and is on its way: then it waits
    /// in the cache, so going back to it is instant.
    private func take(_ patch: ChatPatch) {
        var state = patch.id == chat.id ? chat : (cache[patch.id] ?? ChatState())
        let before = state.messages.map(\.id)
        let wasShown = patch.id == chat.id
        state.apply(patch)
        remember(state)
        if let opening, opening != state.id { return }
        if opening == state.id {
            opening = nil
            Remote.log.notice("chat of \(state.messages.count, privacy: .public) messages in \(Int(Date().timeIntervalSince(self.askedAt) * 1000), privacy: .public) ms")
        }
        let earlier = state.earlier != chat.earlier
        if !wasShown {
            withAnimation(.smooth(duration: 0.22)) { chat = state }
        } else if state.messages.map(\.id) != before {
            // A message came or went: it slides in rather than appearing.
            withAnimation(.snappy(duration: 0.32)) { chat = state }
        } else if state != chat {
            chat = state
        }
        if earlier { fetchingEarlier = false }
        if sending != nil, patch.full || state.messages.count > before.count {
            sending = nil
        }
    }

    private func remember(_ state: ChatState) {
        guard !state.id.isEmpty else { return }
        cache[state.id] = state
        cacheOrder.removeAll { $0 == state.id }
        cacheOrder.append(state.id)
        // ponytail: twelve chats kept in memory; an LRU by size if chats of hundreds of MB show up.
        while cacheOrder.count > 12 {
            cache[cacheOrder.removeFirst()] = nil
        }
    }

    /// The snapshot, a moment after things settle: not on every word of a reply being written.
    private func keep() {
        saving?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, !self.chats.isEmpty else { return }
            Snapshot(pc: self.pc, model: self.model, chats: self.chats, chat: self.chat, conf: self.conf, models: self.models).save()
        }
        saving = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: item)
    }

    private func send(_ object: [String: Any]) {
        guard sealer != nil, let data = try? JSONSerialization.data(withJSONObject: object), let sealed = try? sealer!.seal(data) else { return }
        write(sealed)
    }

    private func write(_ payload: Data) {
        connection?.send(content: Frames.encode(payload), completion: .contentProcessed { _ in })
    }

    // MARK: the guardian

    /// Short-lived connections to the guardian (apiM's port + 1), held while they run so they are not freed mid-send.
    @ObservationIgnored private var guardianLinks: [ObjectIdentifier: NWConnection] = [:]

    /// Launches apiM on the computer if it is closed. Reaches the guardian, which is up even when apiM is not.
    func wakePC() {
        guardianSend(["t": "wake"])
    }

    /// Turns the phone lock on or off. While on, the guardian relaunches apiM whenever anything kills it.
    func lockPC(_ on: Bool) {
        pcLocked = on
        guardianSend(["t": "lock", "on": on])
    }

    /// Opens a one-shot connection to the guardian, does the same hello handshake as the main link, sends a sealed
    /// ping (which the handshake consumes) and then the command, and closes. Tries each paired address in turn.
    private func guardianSend(_ object: [String: Any]) {
        guard let pairing, let payload = try? JSONSerialization.data(withJSONObject: object) else { return }
        guardianAttempt(host: 0, pairing: pairing, payload: payload)
    }

    private func guardianAttempt(host index: Int, pairing: Pairing, payload: Data) {
        guard index < pairing.hosts.count, let port = NWEndpoint.Port(rawValue: pairing.port &+ 1) else { return }
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = 5
        tcp.noDelay = true
        let connection = NWConnection(host: NWEndpoint.Host(pairing.hosts[index]), port: port, using: NWParameters(tls: nil, tcp: tcp))
        let id = ObjectIdentifier(connection)
        guardianLinks[id] = connection
        let mine = Data.random(16)
        var buffer = Data()
        var done = false

        func finish(_ ok: Bool) {
            guard !done else { return }
            done = true
            connection.cancel()
            self.guardianLinks[id] = nil
            if !ok {
                self.guardianAttempt(host: index + 1, pairing: pairing, payload: payload)
            }
        }
        func receive() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { data, _, complete, error in
                if let data, !data.isEmpty {
                    buffer.append(data)
                    if let frames = Frames.take(from: &buffer), let hello = frames.first,
                       let object = try? JSONSerialization.jsonObject(with: hello) as? [String: Any],
                       let nonce = object["nonce"] as? String, let theirs = Data(base64URL: nonce), theirs.count == 16 {
                        var sealer = Sealer(secret: pairing.secret, phone: mine, pc: theirs)
                        if let ping = try? sealer.seal(Data("{\"t\":\"ping\"}".utf8)), let command = try? sealer.seal(payload) {
                            connection.send(content: Frames.encode(ping) + Frames.encode(command), completion: .contentProcessed { _ in
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { finish(true) }
                            })
                        } else {
                            finish(false)
                        }
                        return
                    }
                }
                if complete || error != nil {
                    finish(false)
                    return
                }
                receive()
            }
        }
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                let hello: [String: Any] = ["v": 1, "nonce": mine.base64URL, "name": UIDevice.current.name]
                let data = (try? JSONSerialization.data(withJSONObject: hello)) ?? Data()
                connection.send(content: Frames.encode(data), completion: .contentProcessed { _ in })
                receive()
            case .failed, .waiting:
                finish(false)
            default:
                break
            }
        }
        // Never let a stuck connection hold on: it also retains this model until it is let go.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { finish(false) }
        connection.start(queue: .main)
    }

    private func lost(_ reason: String) {
        Remote.log.notice("lost: \(reason, privacy: .public)")
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
