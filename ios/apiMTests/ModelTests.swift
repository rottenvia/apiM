import XCTest
@testable import apiM

final class ModelTests: XCTestCase {
    private func incoming(_ json: String) throws -> Incoming {
        try JSONDecoder().decode(Incoming.self, from: Data(json.utf8))
    }

    /// The shapes `desktop/src/remote.rs` sends, as its tests make them.
    func testAChatPatchUpdatesOnlyWhatChanged() throws {
        var chat = ChatState()
        chat.apply(try XCTUnwrap(try incoming(#"""
        {"t":"state","chat":{"id":"c1","title":"One","earlier":0,"full":true,"order":["a","b"],"messages":[
          {"id":"a","role":"user","parts":[{"k":"text","text":"hi"}],"files":["shot.png"],"images":[{"id":"a\u001fa0","name":"shot.png"}],"at":1},
          {"id":"b","role":"assistant","parts":[{"k":"think","text":"hm","ms":0},{"k":"tool","id":"t1","kind":"run","title":"Running","target":"cargo test","ok":null,"summary":"","image":"b\u001ftt1"}],"at":2}]}}
        """#).chat))
        XCTAssertEqual(chat.messages.map(\.id), ["a", "b"])
        XCTAssertEqual(chat.messages[0].images, [Picture(id: "a\u{1f}a0", name: "shot.png")])
        guard case .tool(let tool) = chat.messages[1].parts[1] else { return XCTFail("a tool step") }
        XCTAssertNil(tool.ok, "still running")
        XCTAssertEqual(tool.kind, "run")
        XCTAssertEqual(tool.image, "b\u{1f}tt1")

        chat.apply(try XCTUnwrap(try incoming(#"""
        {"t":"state","chat":{"id":"c1","title":"One","earlier":0,"full":false,"order":["a","b"],"messages":[
          {"id":"b","role":"assistant","parts":[{"k":"text","text":"done"}],"at":2}]}}
        """#).chat))
        XCTAssertEqual(chat.messages.count, 2)
        XCTAssertEqual(chat.messages[0].text, "hi", "untouched")
        XCTAssertEqual(chat.messages[1].text, "done")

        chat.apply(try XCTUnwrap(try incoming(#"{"t":"state","chat":{"id":"c1","title":"One","earlier":4,"full":false,"order":["b"],"messages":[]}}"#).chat))
        XCTAssertEqual(chat.messages.map(\.id), ["b"], "a message left the order")
        XCTAssertEqual(chat.earlier, 4)

        chat.apply(try XCTUnwrap(try incoming(#"{"t":"state","chat":{"id":"c2","title":"Two","earlier":0,"full":true,"order":[],"messages":[]}}"#).chat))
        XCTAssertEqual(chat.id, "c2")
        XCTAssertTrue(chat.messages.isEmpty)
    }

    func testTheRestOfAState() throws {
        let state = try incoming(#"""
        {"t":"state","chats":[{"id":"x","title":"Old","updated":1,"running":false,"archived":true},{"id":"y","title":"New","updated":5,"running":true}],
         "run":{"running":true,"status":"Working","approval":{"command":"rm -rf build","reason":"clean"},"question":null},
         "top":{"pc":"HANNIBAL","model":"Claude","notice":""},
         "conf":{"model":"m1","effort":"high","efforts":[{"id":"auto","label":"Auto","about":"Picks.","warn":""},{"id":"high","label":"High","about":"Deep.","warn":""}],
                 "web":"auto","search":"balanced","computer":false,"approval":"manual","lessons":true,"keys":[{"name":"Anthropic","set":true}]},
         "models":[{"id":"m1","label":"Model One","short":"One","about":"","specs":"1M","vision":true,"mine":false}]}
        """#)
        XCTAssertEqual(state.chats?.count, 2)
        XCTAssertEqual(state.chats?.first?.isArchived, true)
        XCTAssertEqual(state.run?.approval?.command, "rm -rf build")
        XCTAssertNil(state.run?.question)
        XCTAssertEqual(state.top?.pc, "HANNIBAL")

        let remote = Remote()
        remote.apply(state)
        XCTAssertEqual(remote.chats.map(\.id), ["y", "x"], "newest first")
        XCTAssertTrue(remote.run.running)
        XCTAssertEqual(remote.conf?.efforts.map(\.id), ["auto", "high"])
        XCTAssertEqual(remote.modelShort, "One")
    }

    func testAPictureFrame() throws {
        let frame = try incoming(#"{"t":"image","id":"m\u001fa0","data":"iVBORw0KGgo="}"#)
        XCTAssertEqual(frame.t, "image")
        XCTAssertEqual(frame.id, "m\u{1f}a0")
        XCTAssertNotNil(frame.data)
        XCTAssertNil(try incoming(#"{"t":"image","id":"gone","missing":true}"#).data)
    }

    /// The snapshot kept between launches reads back as it was written, every kind of piece included.
    func testASnapshotRoundTrips() throws {
        let chat = ChatState(id: "c", title: "T", earlier: 3, messages: [
            Message(id: "a", role: "user", parts: [.text("hi")], files: ["x.png"], images: [Picture(id: "p", name: "x.png")], at: 1),
            Message(id: "b", role: "assistant", parts: [.think("hm", ms: 1200), .tool(Tool(id: "t", kind: "run", title: "Ran", target: "ls", ok: true, summary: "2 files", image: "i")), .notice("Stopped."), .text("done")], model: "M", incomplete: true, at: 2),
        ])
        let snapshot = Snapshot(pc: "PC", model: "M", chats: [ChatRow(id: "c", title: "T", updated: 2, running: false, archived: nil)], chat: chat, conf: nil, models: [])
        let back = try JSONDecoder().decode(Snapshot.self, from: JSONEncoder().encode(snapshot))
        XCTAssertEqual(back.chat, chat)
        XCTAssertEqual(back.chats, snapshot.chats)
    }
}
