import XCTest
@testable import apiM

/// The bytes here are the desktop's (`desktop/src/remote.rs`, `sealing_matches_the_phone`): both ends must agree.
final class WireTests: XCTestCase {
    func testSealingMatchesTheDesktop() throws {
        var phone = Sealer(secret: Data(repeating: 7, count: 32), phone: Data(repeating: 1, count: 16), pc: Data(repeating: 2, count: 16))
        let first = try phone.seal(Data(#"{"t":"ping"}"#.utf8))
        XCTAssertEqual(first.hex, "8e82bbc267d8362e8862c0ad0178ead4cb8d805c8b300faafd309017")
        let second = try phone.seal(Data(#"{"t":"ping"}"#.utf8))
        XCTAssertNotEqual(first, second, "the counter moved on")

        let fromPC = Data(hex: "ffef58d608f84f131a0519f2246d013e3dcc")
        XCTAssertEqual(try phone.open(fromPC), Data("{}".utf8))
        XCTAssertThrowsError(try phone.open(fromPC), "a frame replayed within the connection does not open")
    }

    func testFramesSplitWhereverTheyArrive() {
        let a = Frames.encode(Data("hello".utf8))
        let b = Frames.encode(Data(repeating: 9, count: 70_000))
        var buffer = Data()
        var got: [Data] = []
        for byte in a + b {
            buffer.append(byte)
            got += Frames.take(from: &buffer) ?? []
        }
        XCTAssertEqual(got, [Data("hello".utf8), Data(repeating: 9, count: 70_000)])
        XCTAssertTrue(buffer.isEmpty)

        var huge = Data([0x7F, 0xFF, 0xFF, 0xFF])
        XCTAssertNil(Frames.take(from: &huge), "a length no phone message has means the stream is not ours")

        // A buffer that is itself a slice (its indices do not start at 0) reads the same.
        let both = Data([0xAA]) + a + b
        var slice = both[1...]
        XCTAssertEqual(Frames.take(from: &slice), [Data("hello".utf8), Data(repeating: 9, count: 70_000)])
        XCTAssertTrue(slice.isEmpty)
    }

    func testThePairingLinkReads() throws {
        let secret = Data((0..<32).map { UInt8($0) })
        let link = "apim://pair?v=1&n=Marsel%27s%20PC&p=47100&h=192.168.1.5,100.64.0.2&k=\(secret.base64URL)"
        let pairing = try XCTUnwrap(Pairing(link: link))
        XCTAssertEqual(pairing.name, "Marsel's PC")
        XCTAssertEqual(pairing.port, 47100)
        XCTAssertEqual(pairing.hosts, ["192.168.1.5", "100.64.0.2"])
        XCTAssertEqual(pairing.secret, secret)

        XCTAssertNil(Pairing(link: "https://example.com/?k=\(secret.base64URL)&p=1&h=a"), "not ours")
        XCTAssertNil(Pairing(link: "apim://pair?p=47100&h=1.2.3.4&k=c2hvcnQ"), "a short key")
        XCTAssertNil(Pairing(link: "apim://pair?p=0&h=1.2.3.4&k=\(secret.base64URL)"), "no port")
        XCTAssertNil(Pairing(link: "apim://pair?p=47100&h=&k=\(secret.base64URL)"), "no address")
    }

    func testBase64URLRoundTrips() {
        for count in 0..<40 {
            let data = Data.random(count)
            XCTAssertEqual(Data(base64URL: data.base64URL), data)
        }
    }
}

extension Data {
    init(hex: String) {
        var bytes: [UInt8] = []
        var at = hex.startIndex
        while at < hex.endIndex {
            let next = hex.index(at, offsetBy: 2)
            bytes.append(UInt8(hex[at..<next], radix: 16)!)
            at = next
        }
        self.init(bytes)
    }
}
