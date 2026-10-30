import Foundation

// What the desktop sends (`desktop/src/remote.rs`, `View` and `Sent::patch`), decoded. It all encodes too: the last
// state seen is kept on the phone (`Snapshot`) and shown the moment the app opens, before the computer answers.

struct ChatRow: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var updated: Double
    var running: Bool
    var archived: Bool?

    var isArchived: Bool { archived == true }
}

struct Approval: Codable, Equatable {
    var command: String
    var reason: String
}

struct Question: Codable, Equatable {
    var question: String
    var options: [String]
    var context: String
}

struct RunState: Codable, Equatable {
    var running = false
    var status = ""
    var approval: Approval?
    var question: Question?
    /// The last reply was cut off and can be carried on.
    var resume: Bool?
}

/// A picture in a message. Its bytes are asked for when it comes into view (`Remote.image`).
struct Picture: Codable, Identifiable, Hashable {
    var id: String
    var name: String
}

struct Tool: Equatable {
    var id: String
    var kind: String
    var title: String
    var target: String
    var ok: Bool?
    var summary: String
    /// A `Picture` id for what the step showed (the screen a computer step saw), empty for none.
    var image = ""
}

enum Piece: Codable, Equatable {
    case text(String)
    case think(String, ms: Double)
    case tool(Tool)
    case notice(String)

    private enum Keys: String, CodingKey {
        case k, text, ms, id, kind, title, target, ok, summary, image
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        switch try c.decode(String.self, forKey: .k) {
        case "think":
            self = .think(text, ms: try c.decodeIfPresent(Double.self, forKey: .ms) ?? 0)
        case "tool":
            self = .tool(Tool(
                id: try c.decodeIfPresent(String.self, forKey: .id) ?? "",
                kind: try c.decodeIfPresent(String.self, forKey: .kind) ?? "other",
                title: try c.decodeIfPresent(String.self, forKey: .title) ?? "",
                target: try c.decodeIfPresent(String.self, forKey: .target) ?? "",
                ok: try c.decodeIfPresent(Bool.self, forKey: .ok),
                summary: try c.decodeIfPresent(String.self, forKey: .summary) ?? "",
                image: try c.decodeIfPresent(String.self, forKey: .image) ?? ""
            ))
        case "notice":
            self = .notice(text)
        default:
            self = .text(text)
        }
    }

    /// The desktop's own shape, so a kept snapshot reads back through `init(from:)`.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .text(let text):
            try c.encode("text", forKey: .k)
            try c.encode(text, forKey: .text)
        case .think(let text, let ms):
            try c.encode("think", forKey: .k)
            try c.encode(text, forKey: .text)
            try c.encode(ms, forKey: .ms)
        case .tool(let tool):
            try c.encode("tool", forKey: .k)
            try c.encode(tool.id, forKey: .id)
            try c.encode(tool.kind, forKey: .kind)
            try c.encode(tool.title, forKey: .title)
            try c.encode(tool.target, forKey: .target)
            try c.encodeIfPresent(tool.ok, forKey: .ok)
            try c.encode(tool.summary, forKey: .summary)
            try c.encode(tool.image, forKey: .image)
        case .notice(let text):
            try c.encode("notice", forKey: .k)
            try c.encode(text, forKey: .text)
        }
    }
}

struct Message: Codable, Identifiable, Equatable {
    var id: String
    var role: String
    var parts: [Piece]
    var model: String?
    var error: String?
    var incomplete: Bool?
    var note: Bool?
    var files: [String]?
    var images: [Picture]?
    var at: Double

    var isUser: Bool { role == "user" }

    /// The prose, for copying.
    var text: String {
        parts.compactMap { if case .text(let t) = $0 { return t } else { return nil } }.joined(separator: "\n\n")
    }

    /// Nothing to show yet: the reply has only just been asked for.
    var isEmpty: Bool { parts.isEmpty && (error ?? "").isEmpty }
}

struct Top: Codable, Equatable {
    var pc: String
    var model: String
    var notice: String
}

/// One depth of thinking, in the words of the computer's effort menu for the model in use.
struct Depth: Codable, Identifiable, Equatable {
    var id: String
    var label: String
    var about: String
    var warn: String
}

struct KeyRow: Codable, Equatable {
    var name: String
    var set: Bool
}

/// What the computer's model menu lists.
struct ModelRow: Codable, Identifiable, Equatable {
    var id: String
    var label: String
    var short: String
    var about: String
    var specs: String
    var vision: Bool
    var mine: Bool
}

/// The settings the phone shows and changes (`Remote.set`), each named as the computer's `Command::Set` key.
struct Conf: Codable, Equatable {
    var model: String
    /// "auto", or the depth the model is sent.
    var effort: String
    /// "auto" and the model's own depths, shallowest first. Empty: the model does not think.
    var efforts: [Depth]
    /// auto | always | off
    var web: String
    /// quality | balanced | cheap
    var search: String
    var computer: Bool
    /// manual | critical | auto
    var approval: String
    var lessons: Bool
    var keys: [KeyRow]
}

struct ChatPatch: Decodable {
    var id: String
    var title: String
    var earlier: Int
    var full: Bool
    var order: [String]
    var messages: [Message]
}

/// Any frame from the computer: `state` carries what changed, `image` a picture asked for, `pong` nothing.
struct Incoming: Decodable {
    var t: String
    var chats: [ChatRow]?
    var run: RunState?
    var top: Top?
    var chat: ChatPatch?
    var conf: Conf?
    var models: [ModelRow]?
    var id: String?
    var data: String?
    var missing: Bool?
}

struct ChatState: Codable, Equatable {
    var id = ""
    var title = ""
    var earlier = 0
    var messages: [Message] = []

    /// Takes in a patch: a whole chat replaces this one; otherwise the messages that changed are put in place and the
    /// order says which remain and where.
    mutating func apply(_ patch: ChatPatch) {
        if patch.full || patch.id != id {
            self = ChatState(id: patch.id, title: patch.title, earlier: patch.earlier, messages: patch.messages)
            return
        }
        var byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        for message in patch.messages {
            byID[message.id] = message
        }
        title = patch.title
        earlier = patch.earlier
        messages = patch.order.compactMap { byID[$0] }
    }
}

/// What the app last saw of the computer, kept between launches so the chat is on screen at once.
struct Snapshot: Codable {
    var pc: String
    var model: String
    var chats: [ChatRow]
    var chat: ChatState
    var conf: Conf?
    var models: [ModelRow]

    private static var file: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("snapshot.json")
    }

    static func load(_ done: @escaping (Snapshot?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let snapshot = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Snapshot.self, from: $0) }
            DispatchQueue.main.async { done(snapshot) }
        }
    }

    func save() {
        let copy = self
        DispatchQueue.global(qos: .utility).async {
            guard let data = try? JSONEncoder().encode(copy) else { return }
            try? data.write(to: Snapshot.file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    static func clear() {
        try? FileManager.default.removeItem(at: file)
    }
}
