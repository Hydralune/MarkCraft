//! Optional titles and workspace names from Antigravity's local search catalog.
use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_char, c_int, c_void},
    path::Path,
    ptr,
};

#[link(name = "winsqlite3", kind = "raw-dylib")]
unsafe extern "C" {
    fn sqlite3_open_v2(
        name: *const c_char,
        db: *mut *mut c_void,
        flags: c_int,
        vfs: *const c_char,
    ) -> c_int;
    fn sqlite3_close(db: *mut c_void) -> c_int;
    fn sqlite3_exec(
        db: *mut c_void,
        sql: *const c_char,
        visit: unsafe extern "C" fn(
            *mut c_void,
            c_int,
            *mut *mut c_char,
            *mut *mut c_char,
        ) -> c_int,
        ctx: *mut c_void,
        error: *mut *mut c_char,
    ) -> c_int;
}

type Titles = HashMap<String, (String, String)>;

pub(super) fn desktop_folders(root: &Path) -> Vec<String> {
    let mut folders = Vec::new();
    for entry in super::files(&root.join("config/projects")) {
        let p = entry.path();
        if !p.extension().is_some_and(|e| e == "json") {
            continue;
        }
        let Some(project) = std::fs::read(p)
            .ok()
            .and_then(|v| serde_json::from_slice::<serde_json::Value>(&v).ok())
        else {
            continue;
        };
        if !project["sidecar"].is_null() || project["isWorkspaceOnly"] == true {
            continue;
        }
        for resource in project["projectResources"]["resources"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(path) = resource["folderUri"]
                .as_str()
                .and_then(|s| url::Url::parse(s).ok())
                .and_then(|u| u.to_file_path().ok())
                .filter(|p| p.is_dir())
            {
                folders.push(path.to_string_lossy().into_owned());
            }
        }
    }
    folders.sort();
    folders.dedup();
    folders
}

unsafe extern "C" fn row(
    ctx: *mut c_void,
    count: c_int,
    columns: *mut *mut c_char,
    _: *mut *mut c_char,
) -> c_int {
    if count != 4 {
        return 1;
    }
    // SQLite owns these four text pointers only for the duration of this callback.
    let values = unsafe { std::slice::from_raw_parts(columns, 4) };
    let value = |i: usize| {
        if values[i].is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(values[i]) }
                .to_string_lossy()
                .into_owned()
        }
    };
    let uris = value(2);
    let workspace = serde_json::from_str::<Vec<String>>(&uris)
        .ok()
        .and_then(|v| v.into_iter().next())
        .unwrap_or(uris);
    let project = if workspace.is_empty() {
        value(3)
    } else {
        url::Url::parse(&workspace)
            .ok()
            .and_then(|u| u.to_file_path().ok())
            .map(|p| p.display().to_string())
            .unwrap_or(workspace)
    };
    unsafe { &mut *ctx.cast::<Titles>() }.insert(value(0), (value(1), project));
    0
}

pub(super) fn antigravity(path: &Path) -> Titles {
    let mut titles = Titles::new();
    if !path.is_file() {
        return titles;
    }
    let Ok(name) = CString::new(path.to_string_lossy().as_bytes()) else {
        return titles;
    };
    let mut db = ptr::null_mut();
    // SQLITE_OPEN_READONLY. The JSONL reader also works without this optional database.
    unsafe {
        if sqlite3_open_v2(name.as_ptr(), &mut db, 1, ptr::null()) == 0 {
            sqlite3_exec(db, c"SELECT conversation_id,title,workspace_uris,project_id FROM conversation_summaries".as_ptr(),
                row, (&mut titles as *mut Titles).cast(), ptr::null_mut());
        }
        if !db.is_null() {
            sqlite3_close(db);
        }
    }
    titles
}
