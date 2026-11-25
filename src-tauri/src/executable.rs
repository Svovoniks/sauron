//! The file this process was started from, and whether it is still the one at that path.
//!
//! An update moves the old app away, deletes it and puts the new one in its place, while an MCP server that an agent
//! started keeps running the old code. macOS then refuses that process the keychain operations a client certificate
//! needs: Security.framework works out which code is calling from the file at the process's path, the first time it
//! needs to, and that file is gone or is another build. Importing the certificate fails with OSStatus -26276 and the
//! TLS handshake with "The user name or passphrase you entered is not correct". A process that used the keychain
//! before the update keeps working, because the answer is kept. The MCP server switches to the new file when it
//! notices (see mcp.rs), and errors that may come from this explain it.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

/// What tells one file at a path from another: an update or a reinstall makes a new file (a new inode), and an
/// overwrite in place changes the size or the modification time.
#[derive(Clone, Debug, PartialEq)]
struct FileId {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
}

fn file_id(path: &Path) -> Option<FileId> {
    let meta = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Some(FileId {
        len: meta.len(),
        modified: meta.modified().ok(),
        #[cfg(unix)]
        dev: meta.dev(),
        #[cfg(unix)]
        ino: meta.ino(),
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum State {
    Unchanged,
    /// Another file is at the path: the updated (or reinstalled) app.
    Replaced,
    /// Nothing is at the path any more: moved away or deleted, or an update is putting the new one in place.
    Missing,
}

struct Started {
    path: PathBuf,
    /// None when the file could not be read at the start: then there is nothing to compare with.
    id: Option<FileId>,
}

impl Started {
    fn at(path: PathBuf) -> Started {
        let path = std::path::absolute(&path).unwrap_or(path);
        let id = file_id(&path);
        Started { path, id }
    }

    fn state(&self) -> State {
        let Some(started) = &self.id else { return State::Unchanged };
        match file_id(&self.path) {
            None => State::Missing,
            Some(now) if now == *started => State::Unchanged,
            Some(_) => State::Replaced,
        }
    }
}

static STARTED: OnceLock<Option<Started>> = OnceLock::new();
/// How to get a process running the new file, for the error messages.
static RESTART: OnceLock<&str> = OnceLock::new();

/// Notes which file this process runs, before anything can replace it. restart says how to get a process that runs
/// the file now at that path, for error messages.
pub fn remember(restart: &'static str) {
    STARTED.get_or_init(|| std::env::current_exe().ok().map(Started::at));
    let _ = RESTART.set(restart);
}

/// The path this process was started from (absolute), once remember has run.
pub fn path() -> Option<&'static Path> {
    STARTED.get()?.as_ref().map(|started| started.path.as_path())
}

pub fn state() -> State {
    STARTED.get().and_then(Option::as_ref).map_or(State::Unchanged, Started::state)
}

/// A keychain or TLS error, with what happened and what to do in front when the app has been updated or moved since
/// this process started (on macOS, the only place where that breaks client certificates).
pub fn explain(error: String) -> String {
    if !cfg!(target_os = "macos") {
        return error;
    }
    match (state(), path()) {
        (State::Unchanged, _) | (_, None) => error,
        (_, Some(path)) => explanation(path, RESTART.get().copied().unwrap_or_default(), &error),
    }
}

fn explanation(path: &Path, restart: &str, error: &str) -> String {
    format!(
        "Sauron was updated or moved after this process started ({} is no longer the file it runs), and macOS does \
         not let the old process use the client certificate. {restart} (macOS said: {error})",
        path.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_replaced_or_missing_executable_is_noticed() {
        let dir = std::env::temp_dir().join(format!("sauron-exe-test-{}", uuid::Uuid::new_v4()));
        let (bin, aside) = (dir.join("app/sauron"), dir.join("aside"));
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, "build 1").unwrap();
        let started = Started::at(bin.clone());
        let mut seen = vec![started.state()];

        // moved away and back, as a copy to another folder and back would not be
        std::fs::rename(dir.join("app"), &aside).unwrap();
        seen.push(started.state());
        std::fs::rename(&aside, dir.join("app")).unwrap();
        seen.push(started.state());

        // what the updater does: the old app goes to a backup that is deleted, the new one takes its place
        std::fs::rename(dir.join("app"), &aside).unwrap();
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::copy(aside.join("sauron"), &bin).unwrap();
        std::fs::remove_dir_all(&aside).unwrap();
        seen.push(started.state());

        let unknown = Started::at(dir.join("never-there"));
        std::fs::write(dir.join("never-there"), "").unwrap();
        seen.push(unknown.state());
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(seen, [State::Unchanged, State::Missing, State::Unchanged, State::Replaced, State::Unchanged]);
    }

    #[test]
    fn the_explanation_says_what_happened_and_what_to_do() {
        let text = explanation(Path::new("/Applications/sauron.app/Contents/MacOS/sauron"), "Quit Sauron and open it again.", "OSStatus -26276");
        assert!(text.starts_with("Sauron was updated or moved after this process started"), "{text}");
        assert!(text.contains("/Applications/sauron.app/Contents/MacOS/sauron is no longer the file it runs"), "{text}");
        assert!(text.ends_with("Quit Sauron and open it again. (macOS said: OSStatus -26276)"), "{text}");
    }
}
