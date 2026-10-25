//! What is typed in the message box belongs to the chat it was typed in, with its pasted pictures and attached
//! files. It comes back when that chat is opened again, and after a restart (`drafts.json` in the data folder).
//! One message box used to be shared by every chat: text typed in one went along to whichever was opened next.

use super::App;
use super::attachments::{self, Kept, Pending};
use eframe::egui;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// One chat's unsent message.
struct Draft {
    text: String,
    attached: Vec<Pending>,
    /// Chips read back from disk. They are made live (a picture read, a file ingested) only when their chat is
    /// opened, not at the start for every chat that has one.
    kept: Vec<Kept>,
}

#[derive(Default)]
pub struct Drafts {
    chats: HashMap<String, Draft>,
    /// The new chat left with nothing sent from it yet. "New chat" goes back to it, so what was typed there and
    /// the workspace its files were copied into are not lost behind a fresh id.
    pub blank: Option<String>,
    /// What the message box held when it was last looked at, and since when it has been so without being written.
    seen: u64,
    changed: Option<Instant>,
}

#[derive(Serialize, Deserialize, Default)]
struct OnDisk {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blank: Option<String>,
    #[serde(default)]
    chats: HashMap<String, Stored>,
}

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    #[serde(default)]
    text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attached: Vec<Kept>,
}

fn file() -> PathBuf {
    crate::store::data_dir().join("drafts.json")
}

/// Where a pasted picture waits to be sent. The system's temp folder, where it used to go, can be emptied under a draft.
pub fn pasted_dir() -> PathBuf {
    crate::store::data_dir().join("pasted")
}

impl Drafts {
    pub fn load() -> Drafts {
        let disk: OnDisk = std::fs::read(file()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        // A pasted picture no draft holds any more was sent or taken off.
        let held: HashSet<&Path> = disk.chats.values().flat_map(|d| &d.attached).map(|k| k.path.as_path()).collect();
        sweep(&pasted_dir(), &held);
        let chats = disk.chats.into_iter().map(|(id, d)| (id, Draft { text: d.text, attached: Vec::new(), kept: d.attached })).collect();
        Drafts { chats, blank: disk.blank, seen: 0, changed: None }
    }

    /// A chat nothing was sent from is being left: "New chat" comes back to it. Not in place of one that holds a
    /// draft when it holds none (an empty chat the window fell back on, when the one clicked would not open): the
    /// draft would be kept on disk where nothing reached it.
    pub fn left_blank(&mut self, id: &str) {
        if self.blank.as_ref().is_none_or(|old| !self.chats.contains_key(old) || self.chats.contains_key(id)) {
            self.blank = Some(id.to_string());
        }
    }

    /// A deleted chat's draft goes with it.
    pub fn forget(&mut self, id: &str) {
        let blank = self.blank.take_if(|blank| blank == id).is_some();
        if self.chats.remove(id).is_some() || blank {
            self.changed = Some(Instant::now());
        }
    }
}

/// Removes the files in `dir` that are not in `held`.
fn sweep(dir: &Path, held: &HashSet<&Path>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if !held.contains(entry.path().as_path()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The window opens on the new chat that was left blank last time, with what was typed in it.
pub fn start(app: &mut App) {
    if let Some(id) = app.drafts.blank.take().filter(|id| !app.chats.iter().any(|c| &c.id == id)) {
        app.conv.id = id;
    }
    unstash(app);
}

/// The chat on screen is being left: its message box is put away under it.
pub fn stash(app: &mut App) {
    let draft = Draft { text: std::mem::take(&mut app.draft), attached: std::mem::take(&mut app.attachments), kept: Vec::new() };
    if draft.text.is_empty() && draft.attached.is_empty() {
        app.drafts.chats.remove(&app.conv.id);
    } else {
        app.drafts.chats.insert(app.conv.id.clone(), draft);
    }
    app.attach_error = None;
    forget_undo(app);
}

/// The box's undo history goes with its text: Ctrl+Z in the next chat brought the last one's words back.
pub fn forget_undo(app: &App) {
    app.ctx.data_mut(|d| d.remove::<egui::text_edit::TextEditState>(egui::Id::new("composer-text")));
}

/// The chat now on screen gets back what was typed in it.
pub fn unstash(app: &mut App) {
    let Some(draft) = app.drafts.chats.remove(&app.conv.id) else { return };
    app.draft = draft.text;
    app.attachments = draft.attached;
    for kept in draft.kept {
        attachments::bring_back(app, kept);
    }
}

/// Writes the drafts down once the message box has rested a moment after a change, or at once with `now` (the app closing).
pub fn keep(app: &mut App, now: bool) {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (&app.conv.id, &app.draft, app.drafts.chats.len()).hash(&mut hash);
    // A description arriving changes what is kept of a picture.
    app.attachments.iter().for_each(|a| (&a.path, a.describing()).hash(&mut hash));
    let seen = hash.finish();
    if std::mem::replace(&mut app.drafts.seen, seen) != seen {
        app.drafts.changed = Some(Instant::now());
    }
    if !now && app.drafts.changed.is_none_or(|at| at.elapsed() < Duration::from_millis(600)) {
        return;
    }
    app.drafts.changed = None;
    let mut chats: HashMap<String, Stored> = app.drafts.chats.iter().map(|(id, d)| (id.clone(), Stored { text: d.text.clone(), attached: d.attached.iter().map(attachments::kept).chain(d.kept.iter().cloned()).collect() })).collect();
    if !app.draft.is_empty() || !app.attachments.is_empty() {
        chats.insert(app.conv.id.clone(), Stored { text: app.draft.clone(), attached: app.attachments.iter().map(attachments::kept).collect() });
    }
    // A blank chat on screen is the one to come back to.
    let blank = if app.conv.messages.is_empty() { Some(app.conv.id.clone()) } else { app.drafts.blank.clone() };
    if let Ok(json) = serde_json::to_vec(&OnDisk { blank, chats }) {
        let _ = crate::store::write_atomic(&file(), &json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sweep_keeps_only_the_pictures_a_draft_holds() {
        let dir = std::env::temp_dir().join(format!("apim-pasted-{}", crate::store::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (kept, sent) = (dir.join("pasted-a.png"), dir.join("pasted-b.png"));
        std::fs::write(&kept, b"a").unwrap();
        std::fs::write(&sent, b"b").unwrap();
        sweep(&dir, &HashSet::from([kept.as_path()]));
        assert!(kept.is_file() && !sent.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
