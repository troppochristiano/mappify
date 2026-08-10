//! Double-click launcher for Mappify.
//!
//! Replaces the .bat this used to ship with, for two reasons. Windows refuses to
//! run a .bat carrying Mark of the Web — which every file extracted from a
//! downloaded zip carries — usually with no "run anyway" to click, so the app
//! simply did nothing. And a .bat leaves a console window open for as long as
//! the app runs, which is not what double-clicking something should do.
//!
//! It does as little as possible: start the Node server hidden, wait for it, and
//! make sure it cannot outlive this process. All the behaviour is still in
//! tools/start.js — this is packaging, not a second implementation.

#![windows_subsystem = "windows"]

use std::ffi::OsStr;
use std::fs::{self, File};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::OpenProcess;
use windows_sys::Win32::System::Threading::PROCESS_SET_QUOTA;
use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;
use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

/// Runs a process without giving it a console window of its own.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// The only way to say anything: there is no console attached to this binary.
fn tell(title: &str, body: &str) {
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            wide(body).as_ptr(),
            wide(title).as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

/// Where a crash report can be written and read back. Beside the databases
/// rather than beside the executable, which may be somewhere unwritable.
fn log_path() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join("Mappify");
    let _ = fs::create_dir_all(&dir);
    dir.join("launcher.log")
}

/// A job the child is assigned to, killed when this process exits by any means.
///
/// Without it, closing the launcher from Task Manager would leave the server
/// running with no window and no obvious way to find it — holding the port the
/// app needs, so the next launch would fail for a reason nobody could see.
fn kill_child_with_us(child_pid: u32) {
    unsafe {
        let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child_pid);
        if !proc.is_null() {
            AssignProcessToJobObject(job, proc);
            CloseHandle(proc);
        }
        // `job` is deliberately never closed: the handle living until this
        // process dies is exactly what makes KILL_ON_JOB_CLOSE fire then.
    }
}

/// The bundled runtime if there is one, otherwise whatever `node` is on PATH —
/// the same order the .bat used, so a source checkout still runs.
fn find_node(dir: &Path) -> Option<PathBuf> {
    let bundled = dir.join("runtime").join("node.exe");
    if bundled.is_file() {
        return Some(bundled);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|p| p.join("node.exe"))
        .find(|p| p.is_file())
}

fn main() {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return tell("Mappify", &format!("Cannot find my own location: {e}")),
    };
    let dir = exe.parent().unwrap_or(Path::new(".")).to_path_buf();

    let entry = dir.join("tools").join("start.js");
    if !entry.is_file() {
        return tell(
            "Mappify",
            "This copy is incomplete — tools\\start.js is missing.\n\n\
             Unzip the download again, keeping the whole folder together.",
        );
    }

    let node = match find_node(&dir) {
        Some(n) => n,
        None => {
            let _ = Command::new("cmd")
                .args(["/c", "start", "", "https://nodejs.org"])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
            return tell(
                "Mappify",
                "Mappify needs Node.js, which is a free download.\n\n\
                 nodejs.org is opening — install the LTS version, then try again.",
            );
        }
    };

    // Everything the server prints goes to a file, since nobody can see stdout.
    // It is what gets shown if the run ends badly.
    let log = log_path();
    let out = File::create(&log).ok();
    let err = out.as_ref().and_then(|f| f.try_clone().ok());

    let spawned = Command::new(&node)
        .arg(&entry)
        .current_dir(&dir)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(out.map(Stdio::from).unwrap_or_else(Stdio::null))
        .stderr(err.map(Stdio::from).unwrap_or_else(Stdio::null))
        .spawn();

    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => return tell("Mappify", &format!("Could not start Mappify:\n\n{e}")),
    };

    kill_child_with_us(child.id());

    let status = child.wait();
    let failed = !matches!(&status, Ok(s) if s.success());
    if failed {
        // The log holds the real reason — a port already in use, most likely.
        // Opening it beats paraphrasing it into a dialog box.
        let text = fs::read_to_string(&log).unwrap_or_default();
        let lines: Vec<&str> = text.lines().collect();
        let tail = lines[lines.len().saturating_sub(12)..].join("\n");
        tell(
            "Mappify stopped",
            &format!("{tail}\n\nFull log:\n{}", log.display()),
        );
    }
}
