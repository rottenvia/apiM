# apiM for iPhone

Drives apiM on your computer from your phone: the chats, the chat on screen as it is written, messages and photos, the approval card, `ask_user`'s questions, and Stop. It talks to apiM directly over your network, encrypted with a key that only the QR code carries; there is no server and no account. How the link works is in `desktop/README.md`, "Your phone".

## Install

The app is built on GitHub's Macs (`.github/workflows/ios.yml`) as an unsigned `apiM.ipa`: download it from the run's `apiM-ipa` artifact. iOS installs only signed apps, so it is signed when it goes onto the phone, with your Apple ID:

1. On Windows, install [Sideloadly](https://sideloadly.io) and iTunes from apple.com (not the Microsoft Store one).
2. Plug the iPhone in, open Sideloadly, drop `apiM.ipa` on it, enter your Apple ID, Start.
3. On the iPhone: Settings > Privacy & Security > Developer Mode, on (it restarts). Then Settings > General > VPN & Device Management, trust your Apple ID.

With a free Apple ID the signature lasts 7 days; Sideloadly can sign it again (or AltStore can, on its own). A paid developer account makes it a year.

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
