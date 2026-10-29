import CryptoKit
import Foundation
import Security

// The phone's end of `desktop/src/remote.rs`. Every byte here must match that file: the frame header, the key
// derivation, the nonce layout. `WireTests` checks the same vectors the desktop's tests do.

enum WireError: Error {
    case short
}

/// ChaCha20-Poly1305 both ways, keys from HKDF-SHA256 over the paired secret and both sides' random values.
struct Sealer {
    private let outKey: SymmetricKey
    private let inKey: SymmetricKey
    private var sealed: UInt64 = 0
    private var opened: UInt64 = 0

    init(secret: Data, phone: Data, pc: Data) {
        let salt = phone + pc
        func key(_ info: String) -> SymmetricKey {
            HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret), salt: salt, info: Data(info.utf8), outputByteCount: 32)
        }
        outKey = key("apim phone to pc")
        inKey = key("apim pc to phone")
    }

    mutating func seal(_ plain: Data) throws -> Data {
        let box = try ChaChaPoly.seal(plain, using: outKey, nonce: Sealer.nonce(sealed))
        sealed += 1
        return box.ciphertext + box.tag
    }

    mutating func open(_ frame: Data) throws -> Data {
        guard frame.count >= 16 else { throw WireError.short }
        let bytes = Data(frame)
        let box = try ChaChaPoly.SealedBox(nonce: Sealer.nonce(opened), ciphertext: bytes.prefix(bytes.count - 16), tag: bytes.suffix(16))
        let plain = try ChaChaPoly.open(box, using: inKey)
        opened += 1
        return plain
    }

    /// Four zero bytes, then the frame number big-endian.
    static func nonce(_ n: UInt64) -> ChaChaPoly.Nonce {
        var bytes = Data(count: 4)
        withUnsafeBytes(of: n.bigEndian) { bytes.append(contentsOf: $0) }
        return try! ChaChaPoly.Nonce(data: bytes)
    }
}

enum Frames {
    /// A 4-byte big-endian length, then the bytes.
    static func encode(_ payload: Data) -> Data {
        var length = UInt32(payload.count).bigEndian
        return Data(bytes: &length, count: 4) + payload
    }

    /// Takes every whole frame off the front of `buffer`. Nil when a frame says it is larger than `max`: the stream
    /// is not ours, or is broken. A frame still arriving is not copied: a chat of a few MB comes in hundreds of
    /// pieces, and copying the buffer for each one cost more than reading the chat.
    static func take(from buffer: inout Data, max: Int = 64 << 20) -> [Data]? {
        var frames: [Data] = []
        var at = buffer.startIndex
        while buffer.endIndex - at >= 4 {
            let length = Int(buffer[at]) << 24 | Int(buffer[at + 1]) << 16 | Int(buffer[at + 2]) << 8 | Int(buffer[at + 3])
            if length > max { return nil }
            guard buffer.endIndex - at - 4 >= length else { break }
            frames.append(buffer.subdata(in: (at + 4)..<(at + 4 + length)))
            at += 4 + length
        }
        if at > buffer.startIndex {
            buffer = buffer.subdata(in: at..<buffer.endIndex)
        }
        return frames
    }
}

extension Data {
    init?(base64URL text: String) {
        var plain = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while plain.count % 4 != 0 { plain += "=" }
        self.init(base64Encoded: plain)
    }

    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    var hex: String { map { String(format: "%02x", $0) }.joined() }

    static func random(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes)
    }
}

/// What the QR code in apiM's Settings > Phone holds: `apim://pair?v=1&n=<name>&p=<port>&h=<a>,<b>&k=<secret>`.
struct Pairing: Codable, Equatable {
    var name: String
    var port: UInt16
    var hosts: [String]
    var secret: Data

    init(name: String, port: UInt16, hosts: [String], secret: Data) {
        self.name = name
        self.port = port
        self.hosts = hosts
        self.secret = secret
    }

    init?(link: String) {
        guard let parts = URLComponents(string: link.trimmingCharacters(in: .whitespacesAndNewlines)), parts.scheme?.lowercased() == "apim", parts.host?.lowercased() == "pair" else { return nil }
        var query: [String: String] = [:]
        for item in parts.queryItems ?? [] where query[item.name] == nil {
            query[item.name] = item.value ?? ""
        }
        guard let k = query["k"], let secret = Data(base64URL: k), secret.count == 32,
              let p = query["p"], let port = UInt16(p), port > 0,
              let h = query["h"] else { return nil }
        let hosts = h.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !hosts.isEmpty else { return nil }
        let name = (query["n"] ?? "").trimmingCharacters(in: .whitespaces)
        self.init(name: name.isEmpty ? "your PC" : name, port: port, hosts: hosts, secret: secret)
    }
}

/// The pairing lives in the Keychain, readable only on this phone and only after its first unlock.
enum Keychain {
    private static let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "apim.pairing", kSecAttrAccount as String: "pc"]

    static func load() -> Pairing? {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    static func save(_ pairing: Pairing) {
        guard let data = try? JSONEncoder().encode(pairing) else { return }
        clear()
        var item = base
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    static func clear() {
        SecItemDelete(base as CFDictionary)
    }
}
