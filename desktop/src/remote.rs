//! Remote control: the apiM iPhone app drives the chat on screen over the network.
//!
//! Wire: TCP, each frame a 4-byte big-endian length and then that many bytes. The phone opens with a plain JSON
//! hello carrying 16 random bytes and its name; this side answers with 16 of its own. Every frame after those two
//! is ChaCha20-Poly1305 under a key HKDF-SHA256 derives from the paired 32-byte secret (salt: both random values,
//! the phone's first), one key per direction, the nonce a frame counter. Only a phone holding the secret makes a
//! frame that opens, so a stranger on the network is dropped before it sees or does anything; a frame replayed
//! from an earlier connection fails (the random values are new each time) and one replayed within a connection
//! fails too (the counter has moved on). The secret travels once, in the QR code the phone scans.
//!
//! Nothing here uses the rest of the app, so the iOS app's test server builds this file on its own (`ios/MockServer`).

use std::collections::HashMap;
use std::net::{Ipv4Addr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use ring::rand::{SecureRandom, SystemRandom};
use ring::{aead, hkdf};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::time::Instant;

pub const PORT: u16 = 47100;
/// A message with a few photos fits; anything bigger is not a phone talking.
const MAX_FRAME: usize = 32 << 20;
/// The hello carries 16 random bytes and a name, and the first sealed frame is a ping.
const MAX_HELLO: usize = 1024;
const HELLO_WAIT: Duration = Duration::from_secs(10);
/// The phone pings every 15 s. One that walked out of range never says goodbye: after this long it has gone.
const SILENT: Duration = Duration::from_secs(45);
/// Connections at once, counted before they prove anything: a stranger cannot hold more than this many open, and
/// each for at most `HELLO_WAIT`.
const MAX_OPEN: usize = 16;

// ------------------------------------------------------------------ what the phone sees

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct View {
    /// This computer's name, for the phone's header.
    pub pc: String,
    /// The model the next message goes to.
    pub model: String,
    pub chats: Vec<ChatRow>,
    pub chat: ChatView,
    pub run: RunView,
    /// The window's latest toast (a message that was not sent says why here), empty when there is none.
    pub notice: String,
    /// The settings the phone shows and changes (`Command::Set`), as the window has them.
    pub conf: Conf,
    /// What the window's model menu lists.
    pub models: Vec<ModelRow>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct ChatRow {
    pub id: String,
    pub title: String,
    pub updated: u64,
    pub running: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
}

/// Each field is a `Command::Set` key, with the values the window's own controls take.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Conf {
    /// A `ModelRow` id.
    pub model: String,
    /// "auto", or the depth sent: the model's nearest to the one picked.
    pub effort: String,
    /// "auto" and the model's own depths, shallowest first, with what each does there. Empty: the model has no
    /// thinking to set.
    pub efforts: Vec<Depth>,
    /// auto | always | off
    pub web: String,
    /// quality | balanced | cheap
    pub search: String,
    pub computer: bool,
    /// manual | critical | auto
    pub approval: String,
    pub lessons: bool,
    /// Whether a key is set for each provider. The keys themselves never leave the computer.
    pub keys: Vec<KeyRow>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Depth {
    pub id: String,
    pub label: String,
    pub about: String,
    /// A caution under `about`, empty when there is none.
    pub warn: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct KeyRow {
    pub name: String,
    pub set: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct ModelRow {
    pub id: String,
    pub label: String,
    /// The name in a tight spot: the phone's chip.
    pub short: String,
    pub about: String,
    pub specs: String,
    /// It reads pictures itself.
    pub vision: bool,
    /// Added by the user (Settings > Model), listed under theirs.
    pub mine: bool,
}

/// A picture in a message. Its bytes come on request (`Command::Image`), so a chat full of screenshots costs
/// nothing until one is looked at.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Picture {
    pub id: String,
    pub name: String,
}

/// The chat on screen: its newest messages, and how many older ones were left on the computer.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct ChatView {
    pub id: String,
    pub title: String,
    pub earlier: usize,
    pub messages: Vec<Msg>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Msg {
    pub id: String,
    /// "user" or "assistant".
    pub role: String,
    pub parts: Vec<Piece>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub incomplete: bool,
    /// A "btw" note added while a reply ran.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub note: bool,
    /// Names of the files it carried.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// The pictures among them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<Picture>,
    pub at: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum Piece {
    Text { text: String },
    /// `ms` stays 0 while the model is still thinking.
    Think { text: String, ms: u64 },
    /// `title` in the window's words ("Ran", "Editing"), `target` what it acted on, `kind` which icon it gets
    /// (read, write, delete, search, run, web, plan, git, note, ask, image, computer, done, other).
    /// `image`: a `Picture` id for what the step showed (a computer step's screen, `show_image`), empty for none.
    Tool {
        id: String,
        kind: String,
        title: String,
        target: String,
        ok: Option<bool>,
        summary: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        image: String,
    },
    Notice { text: String },
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct RunView {
    pub running: bool,
    /// "Thinking", "Writing", "Working".
    pub status: String,
    pub approval: Option<Approval>,
    pub question: Option<Question>,
    /// The last reply was cut off and can be continued (`Command::Resume`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub resume: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Approval {
    pub command: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Question {
    pub question: String,
    pub options: Vec<String>,
    pub context: String,
}

// ------------------------------------------------------------------ what the phone asks for

#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Command {
    Open { id: String },
    New,
    Send {
        text: String,
        #[serde(default)]
        photos: Vec<Photo>,
    },
    Stop,
    Allow { allow: bool },
    Answer { text: String },
    /// Answered here and never handed on: it is how each side knows the other is still there.
    Ping,
    /// A `Conf` field changed on the phone.
    Set { key: String, value: serde_json::Value },
    Rename { id: String, title: String },
    Archive { id: String, archived: bool },
    #[serde(rename = "delete_chat")]
    DeleteChat { id: String },
    /// A question and its reply, by the id of either.
    Delete { id: String },
    /// A question asked again in other words: the replies after it go.
    Edit { id: String, text: String },
    /// The last reply, written again.
    Retry,
    /// The last reply, cut off, carried on.
    Resume,
    /// Older messages of the chat on screen.
    More,
    /// A `Picture`'s bytes, sent back to the phones as an `image` frame (`Remote::give`).
    Image { id: String },
}

/// A photo or a file from the phone.
#[derive(Deserialize, Debug, PartialEq)]
pub struct Photo {
    /// A photo's has no extension and is a JPEG; a file's is its own.
    pub name: String,
    /// Base64.
    pub data: String,
}

/// The bytes of a picture a phone asked for.
#[derive(Debug, PartialEq)]
pub enum Found {
    /// A data URL's own base64, as an attachment keeps it.
    Base64(String),
    /// A file the window shows, read off the window's thread.
    File(std::path::PathBuf),
    Missing,
}

// ------------------------------------------------------------------ the server

struct Shared {
    secret: [u8; 32],
    view: watch::Sender<Arc<View>>,
    commands: mpsc::UnboundedSender<Command>,
    // ponytail: every phone gets every picture asked for; per-phone replies if two phones ever look at once.
    pictures: broadcast::Sender<Arc<(String, Found)>>,
    phones: Mutex<Vec<String>>,
    wake: Box<dyn Fn() + Send + Sync>,
}

/// Larger than any screenshot: a picture file past this is not sent.
const MAX_PICTURE: u64 = 24 << 20;

/// The listening link. Dropping it closes the port and every phone's connection.
pub struct Remote {
    shared: Arc<Shared>,
    commands: mpsc::UnboundedReceiver<Command>,
    task: tokio::task::JoinHandle<()>,
    pub port: u16,
}

impl Remote {
    /// Listens on every interface on `port` (0: any free one). `wake` is called when a phone asks for something or
    /// comes and goes, so the window takes it up while it is minimized.
    pub fn start(rt: &tokio::runtime::Handle, port: u16, secret: [u8; 32], wake: impl Fn() + Send + Sync + 'static) -> std::io::Result<Remote> {
        // Bound here rather than in the task, so a port already in use is said at once.
        let listener = std::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, port))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let listener = {
            let _inside = rt.enter();
            TcpListener::from_std(listener)?
        };
        let (commands_tx, commands) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared { secret, view: watch::channel(Arc::new(View::default())).0, commands: commands_tx, pictures: broadcast::channel(16).0, phones: Mutex::new(Vec::new()), wake: Box::new(wake) });
        let task = rt.spawn(accept(listener, shared.clone()));
        Ok(Remote { shared, commands, task, port })
    }

    /// What the phones show from now on. Sent only where it differs from what each was last sent.
    pub fn publish(&self, view: View) {
        self.shared.view.send_if_modified(|old| {
            let changed = **old != view;
            if changed {
                *old = Arc::new(view);
            }
            changed
        });
    }

    /// Answers a `Command::Image`. A file is read by the connections, not here on the window's thread.
    pub fn give(&self, id: String, found: Found) {
        let _ = self.shared.pictures.send(Arc::new((id, found)));
    }

    /// What the phones asked for since the last call.
    pub fn commands(&mut self) -> Vec<Command> {
        std::iter::from_fn(|| self.commands.try_recv().ok()).collect()
    }

    /// The phones connected now, by the name each gave.
    pub fn phones(&self) -> Vec<String> {
        self.shared.phones.lock().unwrap().clone()
    }
}

impl Drop for Remote {
    fn drop(&mut self) {
        // The connections live in the accept task's set, so they close with it.
        self.task.abort();
    }
}

async fn accept(listener: TcpListener, shared: Arc<Shared>) {
    let mut open = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            got = listener.accept() => match got {
                Ok((stream, _)) if open.len() < MAX_OPEN => {
                    open.spawn(serve(stream, shared.clone()));
                }
                Ok(_) => {}
                // Out of sockets or handles: waiting is all that helps, and spinning on it would take a core.
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            },
            Some(_) = open.join_next(), if !open.is_empty() => {}
        }
    }
}

async fn serve(stream: TcpStream, shared: Arc<Shared>) {
    let _ = stream.set_nodelay(true);
    let (mut rd, mut wr) = stream.into_split();
    let Ok(Some((keys, name))) = tokio::time::timeout(HELLO_WAIT, handshake(&mut rd, &mut wr, &shared.secret)).await else { return };
    shared.phones.lock().unwrap().push(name.clone());
    (shared.wake)();
    talk(rd, wr, keys, &shared).await;
    let mut phones = shared.phones.lock().unwrap();
    if let Some(at) = phones.iter().position(|p| *p == name) {
        phones.remove(at);
    }
    drop(phones);
    (shared.wake)();
}

#[derive(Deserialize)]
struct Hello {
    nonce: String,
    #[serde(default)]
    name: String,
}

/// The two hellos and the phone's first sealed frame. None when the phone does not hold the secret.
async fn handshake(rd: &mut (impl AsyncRead + Unpin), wr: &mut (impl AsyncWrite + Unpin), secret: &[u8; 32]) -> Option<(Keys, String)> {
    let hello: Hello = serde_json::from_slice(&read_frame(rd, MAX_HELLO).await.ok()?).ok()?;
    let phone = B64.decode(hello.nonce.trim()).ok().filter(|n| n.len() == 16)?;
    let mut mine = [0u8; 16];
    SystemRandom::new().fill(&mut mine).ok()?;
    write_frame(wr, serde_json::json!({ "v": 1, "nonce": B64.encode(mine) }).to_string().as_bytes()).await.ok()?;
    let mut keys = Keys::new(secret, &phone, &mine, false);
    keys.open(&read_frame(rd, MAX_HELLO).await.ok()?)?;
    let name: String = hello.name.trim().chars().take(60).collect();
    Some((keys, if name.is_empty() { "iPhone".into() } else { name }))
}

async fn talk(mut rd: tokio::net::tcp::OwnedReadHalf, mut wr: tokio::net::tcp::OwnedWriteHalf, mut keys: Keys, shared: &Shared) {
    // Frames are read in a task of their own: `read_exact` is not cancel-safe, and a frame half read when the view
    // changed would be lost and every frame after it misread.
    let (frames_tx, mut frames) = mpsc::channel::<Vec<u8>>(8);
    let reader = tokio::spawn(async move {
        while let Ok(frame) = read_frame(&mut rd, MAX_FRAME).await {
            if frames_tx.send(frame).await.is_err() {
                break;
            }
        }
    });
    let mut view = shared.view.subscribe();
    let mut pictures = shared.pictures.subscribe();
    let mut sent = Sent::default();
    let mut heard = Instant::now();
    loop {
        let now = view.borrow_and_update().clone();
        if let Some(patch) = sent.patch(&now) {
            if !send(&mut wr, &mut keys, &patch).await {
                break;
            }
        }
        tokio::select! {
            frame = frames.recv() => {
                let Some(plain) = frame.and_then(|f| keys.open(&f)) else { break };
                heard = Instant::now();
                match serde_json::from_slice::<Command>(&plain) {
                    Ok(Command::Ping) => {
                        if !send(&mut wr, &mut keys, &serde_json::json!({ "t": "pong" })).await {
                            break;
                        }
                    }
                    Ok(command) => {
                        let _ = shared.commands.send(command);
                        (shared.wake)();
                    }
                    // A newer phone asking for something this side does not know yet.
                    Err(_) => {}
                }
            }
            changed = view.changed() => if changed.is_err() { break },
            picture = pictures.recv() => match picture {
                Ok(picture) => {
                    if !send(&mut wr, &mut keys, &picture_frame(&picture).await).await {
                        break;
                    }
                }
                // Missed while a big one was being written: the phone asks again when it still wants it.
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = tokio::time::sleep_until(heard + SILENT) => break,
        }
    }
    reader.abort();
}

/// `{"t":"image","id":…,"data":<base64>}`, or `"missing":true` when there is nothing to send.
async fn picture_frame((id, found): &(String, Found)) -> serde_json::Value {
    let data = match found {
        Found::Base64(data) => Some(data.clone()),
        Found::File(path) => match tokio::fs::metadata(path).await {
            Ok(meta) if meta.len() <= MAX_PICTURE => tokio::fs::read(path).await.ok().map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)),
            _ => None,
        },
        Found::Missing => None,
    };
    match data {
        Some(data) => serde_json::json!({ "t": "image", "id": id, "data": data }),
        None => serde_json::json!({ "t": "image", "id": id, "missing": true }),
    }
}

/// Seals and writes one message. False when the phone has gone or stopped reading.
async fn send(wr: &mut (impl AsyncWrite + Unpin), keys: &mut Keys, message: &serde_json::Value) -> bool {
    let frame = keys.seal(message.to_string().as_bytes());
    matches!(tokio::time::timeout(SILENT, write_frame(wr, &frame)).await, Ok(Ok(())))
}

async fn read_frame(rd: &mut (impl AsyncRead + Unpin), max: usize) -> std::io::Result<Vec<u8>> {
    let len = rd.read_u32().await? as usize;
    if len > max {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut buf = vec![0; len];
    rd.read_exact(&mut buf).await?;
    Ok(buf)
}

async fn write_frame(wr: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(4 + bytes.len());
    buf.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    buf.extend_from_slice(bytes);
    wr.write_all(&buf).await
}

// ------------------------------------------------------------------ what each phone was last sent

/// Each phone is sent what changed since its last frame: a reply being written re-sends only itself, not the chat.
#[derive(Default)]
struct Sent {
    /// None until the first frame, which carries everything.
    chat: Option<String>,
    head: String,
    order: Vec<String>,
    messages: HashMap<String, String>,
    chats: String,
    run: String,
    top: String,
    conf: String,
    models: String,
}

impl Sent {
    fn patch(&mut self, view: &View) -> Option<serde_json::Value> {
        use serde_json::{Value, json};
        let mut out = serde_json::Map::new();
        let mut changed = |key: &str, value: Value, last: &mut String| {
            let text = value.to_string();
            if *last != text {
                *last = text;
                out.insert(key.into(), value);
            }
        };
        changed("chats", json!(view.chats), &mut self.chats);
        changed("run", json!(view.run), &mut self.run);
        changed("top", json!({ "pc": view.pc, "model": view.model, "notice": view.notice }), &mut self.top);
        changed("conf", json!(view.conf), &mut self.conf);
        changed("models", json!(view.models), &mut self.models);

        let chat = &view.chat;
        let fresh = self.chat.as_deref() != Some(chat.id.as_str());
        if fresh {
            self.chat = Some(chat.id.clone());
            self.messages.clear();
        }
        let mut messages = HashMap::with_capacity(chat.messages.len());
        let mut moved = Vec::new();
        for m in &chat.messages {
            let text = serde_json::to_string(m).unwrap_or_default();
            if self.messages.get(&m.id) != Some(&text) {
                moved.push(json!(m));
            }
            messages.insert(m.id.clone(), text);
        }
        self.messages = messages;
        let order: Vec<String> = chat.messages.iter().map(|m| m.id.clone()).collect();
        let head = json!({ "title": chat.title, "earlier": chat.earlier }).to_string();
        if fresh || !moved.is_empty() || order != self.order || head != self.head {
            self.order = order.clone();
            self.head = head;
            out.insert("chat".into(), json!({ "id": chat.id, "title": chat.title, "earlier": chat.earlier, "full": fresh, "order": order, "messages": moved }));
        }
        if out.is_empty() {
            return None;
        }
        out.insert("t".into(), json!("state"));
        Some(Value::Object(out))
    }
}

// ------------------------------------------------------------------ crypto

struct Keys {
    seal: aead::LessSafeKey,
    open: aead::LessSafeKey,
    sealed: u64,
    opened: u64,
}

impl Keys {
    /// `phone_side` is true for the phone's end (the tests' client).
    fn new(secret: &[u8; 32], phone: &[u8], pc: &[u8], phone_side: bool) -> Keys {
        let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, &[phone, pc].concat());
        let prk = salt.extract(secret);
        let key = |info: &[u8]| aead::LessSafeKey::new(aead::UnboundKey::from(prk.expand(&[info], &aead::CHACHA20_POLY1305).expect("32 bytes is within HKDF's reach")));
        let (to_phone, to_pc) = (key(b"apim pc to phone"), key(b"apim phone to pc"));
        let (seal, open) = if phone_side { (to_pc, to_phone) } else { (to_phone, to_pc) };
        Keys { seal, open, sealed: 0, opened: 0 }
    }

    fn seal(&mut self, plain: &[u8]) -> Vec<u8> {
        let mut buf = plain.to_vec();
        self.seal.seal_in_place_append_tag(counter(self.sealed), aead::Aad::empty(), &mut buf).expect("a frame is far below ChaCha20's limit");
        self.sealed += 1;
        buf
    }

    fn open(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        let mut buf = frame.to_vec();
        let len = self.open.open_in_place(counter(self.opened), aead::Aad::empty(), &mut buf).ok()?.len();
        buf.truncate(len);
        self.opened += 1;
        Some(buf)
    }
}

/// Four zero bytes, then the frame number big-endian.
fn counter(n: u64) -> aead::Nonce {
    let mut bytes = [0u8; 12];
    bytes[4..].copy_from_slice(&n.to_be_bytes());
    aead::Nonce::assume_unique_for_key(bytes)
}

pub fn new_secret() -> [u8; 32] {
    let mut secret = [0u8; 32];
    SystemRandom::new().fill(&mut secret).expect("the system's random source");
    secret
}

pub fn encode_secret(secret: &[u8; 32]) -> String {
    B64.encode(secret)
}

pub fn decode_secret(text: &str) -> Option<[u8; 32]> {
    B64.decode(text.trim()).ok()?.try_into().ok()
}

// ------------------------------------------------------------------ pairing

/// What the QR code holds: `apim://pair?v=1&n=<name>&p=<port>&h=<address>,<address>&k=<secret>`.
pub fn pairing_link(pc: &str, port: u16, addresses: &[String], secret: &[u8; 32]) -> String {
    let name: String = pc.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    format!("apim://pair?v=1&n={name}&p={port}&h={}&k={}", addresses.join(","), encode_secret(secret))
}

/// This computer's addresses a phone can reach: the one the default route leaves by (the home network), and the
/// one Tailscale's address range leaves by (reachable from anywhere, when it is installed). No packet is sent:
/// connecting a UDP socket only asks the routing table.
pub fn addresses() -> Vec<String> {
    let mut found = Vec::new();
    for target in ["192.0.2.1:9", "100.100.100.100:9"] {
        let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) else { continue };
        let Ok(local) = socket.connect(target).and_then(|_| socket.local_addr()) else { continue };
        let ip = local.ip();
        if !ip.is_loopback() && !ip.is_unspecified() && !found.contains(&ip.to_string()) {
            found.push(ip.to_string());
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The iOS app's `CryptoTests` checks the same bytes: both ends must derive the same keys and seal alike.
    #[test]
    fn sealing_matches_the_phone() {
        let mut phone = Keys::new(&[7; 32], &[1; 16], &[2; 16], true);
        let mut pc = Keys::new(&[7; 32], &[1; 16], &[2; 16], false);
        let first = phone.seal(br#"{"t":"ping"}"#);
        let second = phone.seal(br#"{"t":"ping"}"#);
        assert_eq!(hex(&first), "8e82bbc267d8362e8862c0ad0178ead4cb8d805c8b300faafd309017", "phone to pc, frame 0");
        assert_ne!(first, second, "the counter moved on");
        assert_eq!(pc.open(&first).as_deref(), Some(&br#"{"t":"ping"}"#[..]));
        assert_eq!(pc.open(&first), None, "a frame replayed within the connection does not open");
        assert_eq!(pc.open(&second).as_deref(), Some(&br#"{"t":"ping"}"#[..]));
        let back = pc.seal(b"{}");
        assert_eq!(hex(&back), "ffef58d608f84f131a0519f2246d013e3dcc", "pc to phone, frame 0");
        assert_eq!(phone.open(&back).as_deref(), Some(&b"{}"[..]));
    }

    #[test]
    fn a_patch_carries_only_what_changed() {
        let msg = |id: &str, text: &str| Msg { id: id.into(), role: "assistant".into(), parts: vec![Piece::Text { text: text.into() }], ..Default::default() };
        let mut view = View { pc: "PC".into(), chat: ChatView { id: "c1".into(), title: "One".into(), earlier: 0, messages: vec![msg("a", "hi"), msg("b", "wor")] }, ..Default::default() };
        let mut sent = Sent::default();
        let first = sent.patch(&view).unwrap();
        assert_eq!(first["chat"]["full"], true);
        assert_eq!(first["chat"]["messages"].as_array().unwrap().len(), 2);
        assert!(first.get("chats").is_some() && first.get("run").is_some() && first.get("top").is_some());
        assert_eq!(sent.patch(&view), None, "nothing changed, nothing sent");

        view.chat.messages[1] = msg("b", "world");
        let second = sent.patch(&view).unwrap();
        assert_eq!(second["chat"]["full"], false);
        assert_eq!(second["chat"]["messages"].as_array().unwrap().len(), 1, "only the message being written");
        assert_eq!(second["chat"]["messages"][0]["id"], "b");
        assert!(second.get("chats").is_none() && second.get("run").is_none());

        view.chat.messages.remove(0);
        let third = sent.patch(&view).unwrap();
        assert_eq!(third["chat"]["order"], serde_json::json!(["b"]), "a removed message leaves the order");
        assert_eq!(third["chat"]["messages"].as_array().unwrap().len(), 0);

        view.chat = ChatView { id: "c2".into(), title: "Two".into(), earlier: 3, messages: vec![msg("b", "world")] };
        let fourth = sent.patch(&view).unwrap();
        assert_eq!(fourth["chat"]["full"], true, "another chat is sent whole");
        assert_eq!(fourth["chat"]["messages"].as_array().unwrap().len(), 1, "even a message the last chat had");
    }

    #[test]
    fn commands_read_as_the_phone_writes_them() {
        let read = |s: &str| serde_json::from_str::<Command>(s).unwrap();
        assert_eq!(read(r#"{"t":"send","text":"hi"}"#), Command::Send { text: "hi".into(), photos: vec![] });
        assert_eq!(read(r#"{"t":"allow","allow":true}"#), Command::Allow { allow: true });
        assert_eq!(read(r#"{"t":"open","id":"x"}"#), Command::Open { id: "x".into() });
        assert_eq!(read(r#"{"t":"set","key":"effort","value":"high"}"#), Command::Set { key: "effort".into(), value: serde_json::json!("high") });
        assert_eq!(read(r#"{"t":"delete_chat","id":"c"}"#), Command::DeleteChat { id: "c".into() });
        assert_eq!(read(r#"{"t":"archive","id":"c","archived":true}"#), Command::Archive { id: "c".into(), archived: true });
        assert_eq!(read(r#"{"t":"edit","id":"m","text":"again"}"#), Command::Edit { id: "m".into(), text: "again".into() });
        assert_eq!(read(r#"{"t":"more"}"#), Command::More);
        assert!(serde_json::from_str::<Command>(r#"{"t":"teleport"}"#).is_err(), "unknown: skipped by `talk`, not fatal");
    }

    #[test]
    fn the_link_round_trips_the_secret() {
        let secret = new_secret();
        let link = pairing_link("Marsel's PC", 47100, &["192.168.1.5".into(), "100.64.0.2".into()], &secret);
        assert!(link.starts_with("apim://pair?v=1&n=Marsel%27s%20PC&p=47100&h=192.168.1.5,100.64.0.2&k="), "{link}");
        assert_eq!(decode_secret(link.rsplit("k=").next().unwrap()), Some(secret));
    }

    /// A phone end to end over a real socket: the hello, the first state, a command, and a stranger turned away.
    #[test]
    fn a_phone_connects_and_a_stranger_does_not() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let secret = new_secret();
        let mut remote = Remote::start(rt.handle(), 0, secret, || {}).unwrap();
        remote.publish(View { pc: "PC".into(), chat: ChatView { id: "c1".into(), ..Default::default() }, ..Default::default() });
        let port = remote.port;

        async fn phone(port: u16, secret: [u8; 32]) -> Option<(serde_json::Value, TcpStream, Keys)> {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
            let mine = [9u8; 16];
            write_frame(&mut stream, serde_json::json!({ "v": 1, "nonce": B64.encode(mine), "name": "Test iPhone" }).to_string().as_bytes()).await.ok()?;
            let hello: serde_json::Value = serde_json::from_slice(&read_frame(&mut stream, MAX_HELLO).await.ok()?).ok()?;
            let pc = B64.decode(hello["nonce"].as_str()?).ok()?;
            let mut keys = Keys::new(&secret, &mine, &pc, true);
            write_frame(&mut stream, &keys.seal(br#"{"t":"ping"}"#)).await.ok()?;
            let state = keys.open(&tokio::time::timeout(Duration::from_secs(5), read_frame(&mut stream, MAX_FRAME)).await.ok()?.ok()?)?;
            Some((serde_json::from_slice(&state).ok()?, stream, keys))
        }

        let (mut stream, mut keys) = rt.block_on(async {
            assert!(phone(port, new_secret()).await.is_none(), "a phone with another secret sees nothing");
            let (state, mut stream, mut keys) = phone(port, secret).await.expect("the paired phone gets the state");
            assert_eq!(state["t"], "state");
            assert_eq!(state["top"]["pc"], "PC");
            assert_eq!(state["chat"]["id"], "c1");
            assert!(state.get("conf").is_some() && state.get("models").is_some());
            write_frame(&mut stream, &keys.seal(br#"{"t":"send","text":"from the phone"}"#)).await.unwrap();
            write_frame(&mut stream, &keys.seal(br#"{"t":"image","id":"m1\u001fa0"}"#)).await.unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
            (stream, keys)
        });
        assert_eq!(remote.phones(), vec!["Test iPhone".to_string()]);
        assert_eq!(remote.commands(), vec![Command::Send { text: "from the phone".into(), photos: vec![] }, Command::Image { id: "m1\u{1f}a0".into() }]);

        // The picture asked for comes back on its own frame, and a file is read by the connection.
        let file = std::env::temp_dir().join(format!("apim-remote-test-{}.png", std::process::id()));
        std::fs::write(&file, b"PNG!").unwrap();
        remote.give("m1\u{1f}a0".into(), Found::Base64("QUJD".into()));
        remote.give("m1\u{1f}t9".into(), Found::File(file.clone()));
        remote.give("gone".into(), Found::Missing);
        async fn next(stream: &mut TcpStream, keys: &mut Keys) -> serde_json::Value {
            let frame = tokio::time::timeout(Duration::from_secs(5), read_frame(stream, MAX_FRAME)).await.unwrap().unwrap();
            serde_json::from_slice(&keys.open(&frame).unwrap()).unwrap()
        }
        rt.block_on(async {
            let first = next(&mut stream, &mut keys).await;
            assert_eq!((first["t"].as_str(), first["id"].as_str(), first["data"].as_str()), (Some("image"), Some("m1\u{1f}a0"), Some("QUJD")));
            assert_eq!(next(&mut stream, &mut keys).await["data"], "UE5HIQ==");
            assert_eq!(next(&mut stream, &mut keys).await["missing"], true);
        });
        let _ = std::fs::remove_file(file);
    }
}

#[cfg(test)]
mod timing {
    use super::*;

    /// What a phone costs while a long chat is being written to: run with `--ignored --nocapture`.
    #[test]
    #[ignore]
    fn a_long_chat_patches_quickly() {
        let long = "word ".repeat(1200);
        let messages: Vec<Msg> = (0..80).map(|i| Msg { id: i.to_string(), role: "assistant".into(), parts: vec![Piece::Text { text: long.clone() }], ..Default::default() }).collect();
        let mut view = View { chat: ChatView { id: "c".into(), messages, ..Default::default() }, ..Default::default() };
        let mut sent = Sent::default();
        let started = std::time::Instant::now();
        let first = sent.patch(&view).unwrap().to_string().len();
        let whole = started.elapsed();
        let started = std::time::Instant::now();
        let mut bytes = 0;
        for i in 0..100 {
            if let Some(Piece::Text { text }) = view.chat.messages[79].parts.last_mut() {
                text.push_str(&format!("more{i} "));
            }
            bytes += sent.patch(&view).unwrap().to_string().len();
        }
        println!("first frame {first} bytes in {whole:?}; then {:?} and {} bytes a frame while one message grows", started.elapsed() / 100, bytes / 100);
    }
}
