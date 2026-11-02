//! The session view (phase B step 4): a small window kept on top of FL
//! Studio that shows a song's (or beat's, or saved prod's) lyrics large,
//! section by section. It loads the same bundle (`main.tsx` renders
//! `SessionWindow` for this label) and gets the text from the main window
//! through events (src/store/sessionBridge.ts): no file access, no commands
//! of its own (capabilities/session.json).

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "session";

fn window_title(title: &str) -> String {
    let clean: String = title.chars().filter(|c| !c.is_control()).take(80).collect();
    let clean = clean.trim();
    if clean.is_empty() {
        "Hivo · Session".to_string()
    } else {
        format!("Hivo · {clean}")
    }
}

/// Opens the session window (or brings it back, retitled). `async` on
/// purpose: a synchronous command that builds a window deadlocks on Windows
/// (it runs on the main thread, which the window creation waits for).
#[tauri::command]
pub async fn open_session_window(app: AppHandle, title: String) -> Result<(), String> {
    let title = window_title(&title);
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.set_title(&title);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
        .title(&title)
        .inner_size(560.0, 780.0)
        .min_inner_size(360.0, 360.0)
        .always_on_top(true)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| format!("could not open the session window: {e}"))?;
    Ok(())
}

/// The main window is gone: the session window goes too, or it would keep
/// the app running with no way back to the library.
pub fn close_with_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles() {
        assert_eq!(window_title("Envy"), "Hivo · Envy");
        assert_eq!(window_title("  \u{7} "), "Hivo · Session");
        assert_eq!(window_title(&"a".repeat(200)).chars().count(), "Hivo · ".chars().count() + 80);
    }
}
