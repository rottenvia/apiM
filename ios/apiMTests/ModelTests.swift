import XCTest
@testable import apiM

final class ModelTests: XCTestCase {
    private func patch(_ json: String) throws -> Patch {
        try JSONDecoder().decode(Patch.self, from: Data(json.utf8))
    }

    /// The shapes `desktop/src/remote.rs` sends, as its tests make them.
    func testAChatPatchUpdatesOnlyWhatChanged() throws {
        var chat = ChatState()
        chat.apply(try XCTUnwrap(try patch(#"""
        {"t":"state","chat":{"id":"c1","title":"One","earlier":0,"full":true,"order":["a","b"],"messages":[
          {"id":"a","role":"user","parts":[{"k":"text","text":"hi"}],"at":1},
          {"id":"b","role":"assistant","parts":[{"k":"think","text":"hm","ms":0},{"k":"tool","id":"t1","kind":"run","title":"Running","target":"cargo test","ok":null,"summary":""}],"at":2}]}}
        """#).chat))
        XCTAssertEqual(chat.messages.map(\.id), ["a", "b"])
        guard case .tool(let tool) = chat.messages[1].parts[1] else { return XCTFail("a tool step") }
        XCTAssertNil(tool.ok, "still running")
        XCTAssertEqual(tool.kind, "run")

        chat.apply(try XCTUnwrap(try patch(#"""
        {"t":"state","chat":{"id":"c1","title":"One","earlier":0,"full":false,"order":["a","b"],"messages":[
          {"id":"b","role":"assistant","parts":[{"k":"text","text":"done"}],"at":2}]}}
        """#).chat))
        XCTAssertEqual(chat.messages.count, 2)
        XCTAssertEqual(chat.messages[0].text, "hi", "untouched")
        XCTAssertEqual(chat.messages[1].text, "done")

        chat.apply(try XCTUnwrap(try patch(#"{"t":"state","chat":{"id":"c1","title":"One","earlier":4,"full":false,"order":["b"],"messages":[]}}"#).chat))
        XCTAssertEqual(chat.messages.map(\.id), ["b"], "a message left the order")
        XCTAssertEqual(chat.earlier, 4)

        chat.apply(try XCTUnwrap(try patch(#"{"t":"state","chat":{"id":"c2","title":"Two","earlier":0,"full":true,"order":[],"messages":[]}}"#).chat))
        XCTAssertEqual(chat.id, "c2")
        XCTAssertTrue(chat.messages.isEmpty)
    }

    func testTheRestOfAState() throws {
        let p = try patch(#"""
        {"t":"state","chats":[{"id":"x","title":"Old","updated":1,"running":false},{"id":"y","title":"New","updated":5,"running":true}],
         "run":{"running":true,"status":"Working","approval":{"command":"rm -rf build","reason":"clean"},"question":null},
         "top":{"pc":"HANNIBAL","model":"Claude","notice":""}}
        """#)
        XCTAssertEqual(p.chats?.count, 2)
        XCTAssertEqual(p.run?.approval?.command, "rm -rf build")
        XCTAssertNil(p.run?.question)
        XCTAssertEqual(p.top?.pc, "HANNIBAL")

        let remote = Remote()
        remote.apply(p)
        XCTAssertEqual(remote.chats.map(\.id), ["y", "x"], "newest first")
        XCTAssertTrue(remote.run.running)
    }
}
