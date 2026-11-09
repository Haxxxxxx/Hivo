mod beats;
mod actions;
mod ai;
mod audio;
mod daws;
mod error;
mod digger;
mod cover;
mod files;
mod key;
mod kits;
mod leads;
mod lookup;
mod location;
mod flp_build;
mod flp_metadata;
mod models;
mod package;
mod paths;
mod phone_inbox;
mod firewall;
mod phone_sync;
mod render;
mod resolve;
mod scanner;
mod scope;
mod sections;
mod session;
mod settings;
mod shorts;
mod sketch;
mod workspace;
mod youtube;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            phone_sync::init(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                session::close_with_main(tauri::Manager::app_handle(window));
            }
        })
        .invoke_handler(tauri::generate_handler![
            scanner::scan_projects,
            location::app_location,
            settings::get_settings,
            settings::take_settings_recovery,
            settings::unreachable_setting_folders,
            settings::save_settings,
            settings::detect_fl_studio,
            settings::detect_daw_folders,
            settings::pick_watched_folder,
            settings::link_detected_folder,
            settings::remove_watched_folder,
            settings::repoint_watched_folder,
            settings::pick_output_folder,
            settings::pick_beat_folder,
            settings::remove_beat_folder,
            settings::pick_sample_folder,
            settings::remove_sample_folder,
            beats::scan_beats,
            digger::dig_beats,
            digger::dig_deeper,
            digger::reset_web_search,
            digger::save_last_dig,
            digger::load_last_dig,
            beats::analyze_beats,
            lookup::classify_profile_link,
            leads::save_lead,
            leads::list_leads,
            leads::delete_lead,
            lookup::lookup_artists,
            lookup::lookup_profile,
            lookup::spotify_status,
            lookup::set_spotify_credentials,
            settings::pick_fl_studio,
            settings::use_detected_fl_studio,
            settings::pick_ffmpeg,
            settings::use_detected_ffmpeg,
            settings::clear_path_setting,
            render::render_projects,
            workspace::get_workspace,
            workspace::save_workspace,
            workspace::workspace_files,
            workspace::restore_workspace_backup,
            workspace::set_aside_workspace,
            workspace::show_config_folder,
            actions::list_templates,
            actions::default_template,
            actions::create_project,
            actions::duplicate_project,
            actions::restore_backup,
            actions::trash_backups,
            sketch::continue_sketch,
            session::open_session_window,
            actions::backups_on_risky_volumes,
            package::package_preview,
            package::package_projects,
            files::kit_files,
            files::bandlab_files,
            audio::analyze_audio,
            audio::export_launch_kit,
            audio::read_kit_cover,
            ai::ai_status,
            ai::set_ai_key,
            ai::ai_kit,
            shorts::shorts_status,
            shorts::render_shorts,
            cover::cover_status,
            cover::set_cover_credentials,
            cover::generate_cover,
            cover::save_cover,
            youtube::youtube_status,
            youtube::set_youtube_key,
            youtube::youtube_search,
            phone_sync::phone_sync_status,
            phone_sync::phone_sync_enable,
            phone_sync::phone_sync_pair,
            phone_sync::phone_sync_open_firewall,
            phone_sync::phone_sync_firewall_check,
            phone_sync::phone_sync_firewall_fix,
            phone_sync::phone_sync_forget,
            phone_sync::phone_sync_repair,
            phone_sync::phone_sync_confirm,
            phone_sync::phone_inbox_link_memo,
            phone_sync::phone_sync_reply,
            phone_sync::phone_sync_set_demo,
            phone_sync::phone_inbox_list,
            phone_sync::phone_inbox_file_sketch,
            phone_sync::phone_inbox_attach_song,
            phone_sync::phone_inbox_mark,
            phone_sync::phone_inbox_remove,
            paths::open_project,
            paths::reveal_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod acl_tests {
    use std::collections::BTreeSet;

    fn handler_commands() -> BTreeSet<String> {
        let src = include_str!("lib.rs");
        let block = src.split("generate_handler![").nth(1).unwrap().split("])").next().unwrap();
        block
            .lines()
            .filter_map(|l| l.trim().trim_end_matches(',').rsplit_once("::").map(|(_, c)| c.to_string()))
            .collect()
    }

    #[test]
    fn app_commands_are_declared_and_granted() {
        let handlers = handler_commands();
        assert!(handlers.len() > 50);

        let build = include_str!("../build.rs");
        let declared: BTreeSet<String> = build
            .split("const COMMANDS")
            .nth(1)
            .unwrap()
            .split("];")
            .next()
            .unwrap()
            .lines()
            .filter_map(|l| l.trim().strip_prefix('"').and_then(|l| l.strip_suffix("\",")).map(str::to_string))
            .collect();
        assert_eq!(handlers, declared, "build.rs COMMANDS must list exactly the commands in generate_handler!");

        let perm = |c: &String| format!("allow-{}", c.replace('_', "-"));
        let main: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let granted: BTreeSet<String> = main["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str().map(str::to_string))
            .collect();
        for c in &handlers {
            assert!(granted.contains(&perm(c)), "default.json must grant {}", perm(c));
        }

        // The session window only listens to events: no app command, ever.
        let session: serde_json::Value = serde_json::from_str(include_str!("../capabilities/session.json")).unwrap();
        for p in session["permissions"].as_array().unwrap() {
            let p = p.as_str().unwrap();
            assert!(p.contains(':'), "session.json must not grant app command {p}");
        }
    }
}
