import Foundation

// What the desktop sends (`desktop/src/remote.rs`, `View` and `Sent::patch`), decoded.

struct ChatRow: Decodable, Identifiable, Equatable {
    var id: String
    var title: String
    var updated: Double
    var running: Bool
}

struct Approval: Decodable, Equatable {
    var command: String
    var reason: String
}

struct Question: Decodable, Equatable {
    var question: String
    var options: [String]
    var context: String
}

struct RunState: Decodable, Equatable {
    var running = false
    var status = ""
    var approval: Approval?
    var question: Question?
}

struct Tool: Equatable {
    var id: String
    var kind: String
    var title: String
    var target: String
    var ok: Bool?
    var summary: String
}

enum Piece: Decodable, Equatable {
    case text(String)
    case think(String, ms: Double)
    case tool(Tool)
    case notice(String)

    private enum Keys: String, CodingKey {
        case k, text, ms, id, kind, title, target, ok, summary
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
                summary: try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
            ))
        case "notice":
            self = .notice(text)
        default:
            self = .text(text)
        }
    }
}

struct Message: Decodable, Identifiable, Equatable {
    var id: String
    var role: String
    var parts: [Piece]
    var model: String?
    var error: String?
    var incomplete: Bool?
    var note: Bool?
    var files: [String]?
    var at: Double

    var isUser: Bool { role == "user" }

    /// The prose, for copying.
    var text: String {
        parts.compactMap { if case .text(let t) = $0 { return t } else { return nil } }.joined(separator: "\n\n")
    }

    /// Nothing to show yet: the reply has only just been asked for.
    var isEmpty: Bool { parts.isEmpty && (error ?? "").isEmpty }
}

struct Top: Decodable, Equatable {
    var pc: String
    var model: String
    var notice: String
}

struct ChatPatch: Decodable {
    var id: String
    var title: String
    var earlier: Int
    var full: Bool
    var order: [String]
    var messages: [Message]
}

struct Patch: Decodable {
    var chats: [ChatRow]?
    var run: RunState?
    var top: Top?
    var chat: ChatPatch?
}

struct ChatState: Equatable {
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
