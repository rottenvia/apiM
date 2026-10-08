//! Chrome DevTools Protocol over a minimal WebSocket client.
//!
//! Localhost only (`ws://127.0.0.1`), so the server's accept key is not checked.
//! Text frames only, client frames always masked, 7/16/64-bit lengths, ping answered with pong.
//!
//! ponytail: no fragmented sends and no close-handshake wait. Messages over 256 MB are refused.

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, mpsc, oneshot};

const MAX_MESSAGE: u64 = 256 << 20;

type Pending = Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
type Writer = Arc<Mutex<WriteHalf<TcpStream>>>;

/// A connected CDP client. Cheap to clone; every clone shares one socket.
#[derive(Clone)]
pub struct Cdp {
    writer: Writer,
    next: Arc<AtomicU64>,
    pending: Pending,
}

fn random_u64() -> u64 {
    // Each RandomState is seeded fresh, which is plenty for a WebSocket mask on localhost.
    RandomState::new().build_hasher().finish()
}

fn lost(e: std::io::Error) -> String {
    format!("lost the connection to the browser: {e}")
}

impl Cdp {
    /// Open `ws://127.0.0.1:{port}{path}`. Returns the client and the stream of events (messages with no id).
    pub async fn connect(port: u16, path: &str) -> Result<(Cdp, mpsc::UnboundedReceiver<Value>), String> {
        let stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(|e| format!("could not reach the browser's debug port {port}: {e}"))?;
        let (rd, wr) = tokio::io::split(stream);
        let mut reader = BufReader::new(rd);
        let writer: Writer = Arc::new(Mutex::new(wr));

        let mut raw = [0u8; 16];
        raw[..8].copy_from_slice(&random_u64().to_le_bytes());
        raw[8..].copy_from_slice(&random_u64().to_le_bytes());
        let key = base64::engine::general_purpose::STANDARD.encode(raw);
        let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n");
        writer.lock().await.write_all(request.as_bytes()).await.map_err(lost)?;

        let mut status = String::new();
        reader.read_line(&mut status).await.map_err(lost)?;
        if !status.contains(" 101 ") {
            return Err(format!("the browser refused the WebSocket upgrade: {}", status.trim()));
        }
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).await.map_err(lost)? == 0 || line == "\r\n" {
                break;
            }
        }

        let pending: Pending = Default::default();
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (pending_rx, writer_rx) = (pending.clone(), writer.clone());
        tokio::spawn(async move {
            while let Ok(text) = read_text(&mut reader, &writer_rx).await {
                let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
                match msg.get("id").and_then(Value::as_u64) {
                    Some(id) => {
                        let tx = pending_rx.lock().unwrap().remove(&id);
                        if let Some(tx) = tx {
                            let answer = match msg.get("error") {
                                Some(e) => Err(e["message"].as_str().unwrap_or("the browser reported an error").to_string()),
                                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                            };
                            let _ = tx.send(answer);
                        }
                    }
                    None => {
                        let _ = events_tx.send(msg);
                    }
                }
            }
            // The socket is gone: dropping the senders wakes every caller still waiting.
            pending_rx.lock().unwrap().clear();
        });

        Ok((Cdp { writer, next: Arc::new(AtomicU64::new(1)), pending }, events_rx))
    }

    /// One CDP command. `session` routes it to an attached target (flattened sessions).
    pub async fn call(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        if let Err(e) = send_frame(&self.writer, 0x1, msg.to_string().as_bytes()).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match rx.await {
            Ok(answer) => answer,
            Err(_) => Err("the browser closed the connection".to_string()),
        }
    }
}

/// Send one masked frame. Client frames must be masked, so a random key is always applied.
async fn send_frame(writer: &Mutex<WriteHalf<TcpStream>>, opcode: u8, payload: &[u8]) -> Result<(), String> {
    let len = payload.len();
    let mut frame = vec![0x80 | opcode];
    if len < 126 {
        frame.push(0x80 | len as u8);
    } else if len <= 0xffff {
        frame.push(0x80 | 126);
        frame.extend((len as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend((len as u64).to_be_bytes());
    }
    let key: [u8; 4] = random_u64().to_be_bytes()[..4].try_into().expect("four bytes");
    frame.extend(key);
    frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ key[i % 4]));
    writer.lock().await.write_all(&frame).await.map_err(lost)
}

/// Read one complete text message, joining fragments. Pings are answered; pongs and binary are skipped.
async fn read_text<R: AsyncReadExt + Unpin>(reader: &mut R, writer: &Mutex<WriteHalf<TcpStream>>) -> Result<String, String> {
    let mut message = Vec::new();
    loop {
        let mut head = [0u8; 2];
        reader.read_exact(&mut head).await.map_err(lost)?;
        let fin = head[0] & 0x80 != 0;
        let opcode = head[0] & 0x0f;
        let len = match head[1] & 0x7f {
            126 => {
                let mut b = [0u8; 2];
                reader.read_exact(&mut b).await.map_err(lost)?;
                u16::from_be_bytes(b) as u64
            }
            127 => {
                let mut b = [0u8; 8];
                reader.read_exact(&mut b).await.map_err(lost)?;
                u64::from_be_bytes(b)
            }
            n => n as u64,
        };
        if len > MAX_MESSAGE {
            return Err("a message from the browser is too large to read".to_string());
        }
        let mut payload = vec![0u8; len as usize];
        reader.read_exact(&mut payload).await.map_err(lost)?;
        match opcode {
            0x8 => return Err("the browser closed the connection".to_string()),
            0x9 => send_frame(writer, 0xA, &payload).await?,
            0x0 | 0x1 => {
                message.extend_from_slice(&payload);
                if fin {
                    return Ok(String::from_utf8_lossy(&message).into_owned());
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// Accepts one client, then answers every request with a result that is padded to the requested size.
    async fn echo_server(listener: TcpListener) {
        let (sock, _) = listener.accept().await.unwrap();
        let (rd, mut wr) = tokio::io::split(sock);
        let mut rd = BufReader::new(rd);
        let mut key = String::new();
        loop {
            let mut line = String::new();
            rd.read_line(&mut line).await.unwrap();
            if let Some(v) = line.strip_prefix("Sec-WebSocket-Key: ") {
                key = v.trim().to_string();
            }
            if line == "\r\n" {
                break;
            }
        }
        let accept = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {key}\r\n\r\n");
        wr.write_all(accept.as_bytes()).await.unwrap();
        loop {
            let mut head = [0u8; 2];
            if rd.read_exact(&mut head).await.is_err() {
                return;
            }
            let len = match head[1] & 0x7f {
                126 => {
                    let mut b = [0u8; 2];
                    rd.read_exact(&mut b).await.unwrap();
                    u16::from_be_bytes(b) as usize
                }
                127 => {
                    let mut b = [0u8; 8];
                    rd.read_exact(&mut b).await.unwrap();
                    u64::from_be_bytes(b) as usize
                }
                n => n as usize,
            };
            let mut mask = [0u8; 4];
            rd.read_exact(&mut mask).await.unwrap();
            let mut payload = vec![0u8; len];
            rd.read_exact(&mut payload).await.unwrap();
            for (i, b) in payload.iter_mut().enumerate() {
                *b ^= mask[i % 4];
            }
            let req: Value = serde_json::from_slice(&payload).unwrap();
            assert_eq!(req["params"]["big"].as_str().map(str::len), Some(70_000), "client frame arrived intact");
            let pad = req["params"]["pad"].as_u64().unwrap_or(0) as usize;
            let text = json!({ "id": req["id"], "result": { "method": req["method"], "pad": "x".repeat(pad) } }).to_string();
            let bytes = text.as_bytes();
            let mut out = vec![0x81];
            if bytes.len() < 126 {
                out.push(bytes.len() as u8);
            } else if bytes.len() <= 0xffff {
                out.push(126);
                out.extend((bytes.len() as u16).to_be_bytes());
            } else {
                out.push(127);
                out.extend((bytes.len() as u64).to_be_bytes());
            }
            out.extend_from_slice(bytes);
            wr.write_all(&out).await.unwrap();
        }
    }

    #[tokio::test]
    async fn round_trip_short_medium_and_long_frames() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(echo_server(listener));
        let (cdp, _events) = Cdp::connect(port, "/devtools/browser/test").await.unwrap();
        for pad in [10usize, 300, 70_000] {
            let r = cdp.call("Test.echo", json!({ "pad": pad, "big": "y".repeat(70_000) }), None).await.unwrap();
            assert_eq!(r["method"], "Test.echo");
            assert_eq!(r["pad"].as_str().unwrap().len(), pad);
        }
    }
}
