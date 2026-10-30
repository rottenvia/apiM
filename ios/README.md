# apiM for iPhone

Drives apiM on your computer from your phone. It talks to apiM directly over your network, encrypted with a key that only the QR code carries; there is no server and no account. How the link works is in `desktop/README.md`, "Your phone".

- **The chats.** The chat on screen as it is written, with thoughts, steps (and the screenshots a step took), the approval card, `ask_user`'s questions and Stop. Swipe right from the left half of the screen for the chats: search, a new chat, archived chats, and rename, archive or delete by swiping a row or holding it.
- **Writing.** Messages with photos (library, camera, or pasted) and files. Hold a message to copy it, select part of it, edit it (the replies after it are written again), regenerate a reply or delete it. A reply cut off part way has Resume.
- **The desktop's controls.** The model (built in and your own), effort with the slider the desktop has, web search and the computer from the composer; in Settings also search depth, how commands are approved, learning from the project, and which API keys the computer has (only whether each is set, never the key).
- **Pictures open full screen.** Tap a photo or screenshot: it zooms out of its place, pinches to 5x, double taps, and shares or saves.
- **Fast.** A chat opened before shows at once from the phone's own copy while the computer sends what changed; the app opens on the chats it showed last. Long chats load their last 80 messages and the earlier ones with a tap at the top; they are drawn lazily, so a chat of hundreds of messages opens in the same time as a short one. Messages are decoded and their markdown laid out off the main thread, once. The motion that lasts (the waiting dots, the mark, the placeholders, the "Thinking" shimmer) runs on Core Animation, so the main thread is free while it moves. Measured on the CI simulator (iPhone 17 Pro, iOS 26.2): a chat's last 80 messages are on screen 120 to 300 ms after the tap, the round trip to the computer included, and the app sits idle between the UI tests' steps (sampled every 15 s).

## Install and update

The app is built on GitHub's Macs (`.github/workflows/ios.yml`) as an unsigned `apiM.ipa`. iOS installs only signed apps, so it is signed on its way onto the phone, with your Apple ID. It needs iOS 18.

**SideStore or AltStore: updates in place.** Each build of main that passes every test goes to the [`ios` release](https://github.com/rottenvia/apiM/releases/tag/ios) with a source file. Add this as a source (AltStore: Browse > Sources > +; SideStore: Sources > +):

```
https://github.com/rottenvia/apiM/releases/download/ios/apps.json
```

Install apiM from it; each new build then shows as an update to tap. The app is replaced and keeps its pairing and its chats. Both re-sign it every 7 days on their own.

**Sideloadly.** Download `apiM.ipa` from the release (or a run's `apiM-ipa` artifact):

1. On Windows, install [Sideloadly](https://sideloadly.io) and iTunes from apple.com (not the Microsoft Store one).
2. Plug the iPhone in, open Sideloadly, drop `apiM.ipa` on it, enter your Apple ID, Start.
3. On the iPhone: Settings > Privacy & Security > Developer Mode, on (it restarts). Then Settings > General > VPN & Device Management, trust your Apple ID.

A newer `apiM.ipa` put on the same way, with the same Apple ID, is an update too: nothing is lost. With a free Apple ID the signature lasts 7 days and Sideloadly signs it again; a paid developer account makes it a year. Moving from one tool to the other can install it as a second app, which is paired once.

A change on the computer's side alone (what the phone is shown, what its buttons do: `desktop/src/ui/remote.rs`) needs no new app, only the new apiM on the computer. The app's own code cannot be swapped inside an installed app; iOS allows that only through a new build.

## Pair

1. In apiM on the computer: Settings > Phone, turn on Remote control.
2. Scan the code with the iPhone's Camera (it opens apiM) or with Scan code in the app. No camera at hand: Copy pairing link there, get it to the phone, and Paste pairing link here.
3. The first time, iOS asks to let apiM find devices on your local network, and Windows asks to let apiM through the firewall: allow both, on private networks.

The phone and the computer must be on the same Wi-Fi, or both on Tailscale to reach it from anywhere. "Unpair all phones" on the computer cuts every phone off; "Unpair this phone" in the app's Settings forgets the computer.

## Build and test on a Mac

```
brew install xcodegen
cd ios && xcodegen generate && open apiM.xcodeproj
```

The UI tests need the test server running: `cargo run --release --manifest-path ios/MockServer/Cargo.toml -- --port 47199 --secret AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`. It is the desktop's own `remote.rs`, compiled on its own, in front of a scripted chat that replies with a thought, a step waiting for approval and an answer; `?ask` in a message gets a question, and `fail` is refused the way apiM refuses a message it has no key for.

The workflow runs all of it on every push that touches `ios/` or `desktop/src/remote.rs`: the unsigned build, the unit tests (the crypto's bytes against the desktop's, the frames, the pairing link, the patches, the markdown), and the UI tests in light and then dark, with a screenshot at each step in the `test-results` artifact.
