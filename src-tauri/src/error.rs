//! Errors the webview translates.
//!
//! Commands keep `Result<T, String>`, but a user-facing failure is a coded
//! error serialized as JSON in that string:
//!
//! ```json
//! {"code":"scope.denied","params":{"what":"project","path":"…"},"detail":"That project isn't inside…"}
//! ```
//!
//! `src/lib/errors.ts` maps every code to an English and a French sentence
//! (`errorText`); `detail` is the raw English, kept for the tooltip and the
//! "Report this" feedback, and shown when the app doesn't know the code.
//! A plain (uncoded) string still works: the webview wraps it in a
//! translated lead sentence.
//!
//! `?` turns an `AppError` into the `String` a command returns. Wrapping a
//! coded error in another message (`format!("…: {e}")`) would bury the JSON:
//! use `detail_of` for that.

use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Serialize)]
pub struct AppError {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
}

/// A coded error with its English detail.
pub fn app_err(code: &'static str, detail: impl Into<String>) -> AppError {
    AppError { code, params: Map::new(), detail: detail.into() }
}

impl AppError {
    /// A value the translated sentence uses (a path, a count, a name).
    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.params.insert(key.to_string(), value.into());
        self
    }
}

/// A coded error about one file or folder (`path` param = its display path).
pub fn path_err(code: &'static str, path: &std::path::Path, detail: impl Into<String>) -> String {
    app_err(code, detail).with("path", path.display().to_string()).into()
}

impl From<AppError> for String {
    fn from(e: AppError) -> String {
        serde_json::to_string(&e).unwrap_or(e.detail)
    }
}

#[derive(serde::Deserialize)]
struct Detail {
    #[allow(dead_code)]
    code: String,
    #[serde(default)]
    detail: String,
}

/// The English text of an error string, coded or not.
pub fn detail_of(err: &str) -> String {
    if err.starts_with('{') {
        if let Ok(d) = serde_json::from_str::<Detail>(err) {
            return d.detail;
        }
    }
    err.to_string()
}

/// `err` as is when it's coded, else coded as `code` with `err` as detail.
pub fn ensure_code(code: &'static str, err: String) -> String {
    if code_of_str(&err).is_some() {
        err
    } else {
        app_err(code, err).into()
    }
}

fn code_of_str(err: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Code {
        code: String,
    }
    if !err.starts_with('{') {
        return None;
    }
    serde_json::from_str::<Code>(err).ok().map(|c| c.code)
}

/// An error string cut to `max` characters of English (a coded error keeps
/// its code and params whole: only its detail is cut).
pub fn clip(err: &str, max: usize) -> String {
    if err.starts_with('{') {
        if let Ok(mut v) = serde_json::from_str::<Value>(err) {
            if v.get("code").is_some_and(Value::is_string) {
                if let Some(d) = v.get("detail").and_then(Value::as_str) {
                    let cut: String = d.chars().take(max).collect();
                    v["detail"] = Value::String(cut);
                }
                return v.to_string();
            }
        }
    }
    err.chars().take(max).collect()
}

/// The code of an error string, if it has one.
#[cfg(test)]
pub fn code_of(err: &str) -> Option<String> {
    code_of_str(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_code_params_and_detail() {
        let s: String = app_err("scope.denied", "That project isn't inside \"X\"").with("what", "project").with("n", 3).into();
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["code"], "scope.denied");
        assert_eq!(v["params"]["what"], "project");
        assert_eq!(v["params"]["n"], 3);
        assert_eq!(detail_of(&s), "That project isn't inside \"X\"");
        assert_eq!(code_of(&s).as_deref(), Some("scope.denied"));
    }

    /// Every code a command can send has its sentence in src/lib/errors.ts.
    #[test]
    fn every_code_is_translated() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let ts = std::fs::read_to_string(root.join("../src/lib/errors.ts")).unwrap();
        let mut missing = Vec::new();
        let mut seen = 0;
        for entry in std::fs::read_dir(root.join("src")).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|e| e != "rs") || path.file_name().is_some_and(|n| n == "error.rs") {
                continue;
            }
            let src = std::fs::read_to_string(&path).unwrap();
            for call in ["app_err(", "path_err("] {
                for (at, _) in src.match_indices(call) {
                    let rest = src[at + call.len()..].trim_start();
                    let Some(rest) = rest.strip_prefix('"') else { continue };
                    let code = &rest[..rest.find('"').unwrap()];
                    seen += 1;
                    if !ts.contains(&format!("\"{code}\":")) {
                        missing.push(format!("{code} ({})", path.display()));
                    }
                }
            }
        }
        assert!(seen > 150, "only {seen} coded errors found");
        assert!(missing.is_empty(), "codes with no sentence in src/lib/errors.ts: {missing:?}");
    }

    #[test]
    fn clip_keeps_codes_whole() {
        let long: String = app_err("x.y", "a".repeat(500)).with("path", "/p").into();
        let cut = clip(&long, 10);
        assert_eq!(code_of(&cut).as_deref(), Some("x.y"));
        assert_eq!(detail_of(&cut), "a".repeat(10));
        assert_eq!(clip("plain text", 5), "plain");
        assert_eq!(ensure_code("x.z", "plain".into()), r#"{"code":"x.z","detail":"plain"}"#);
        assert_eq!(ensure_code("x.z", long.clone()), long);
    }

    #[test]
    fn plain_strings_pass_through() {
        assert_eq!(detail_of("boom"), "boom");
        assert_eq!(detail_of("{not json"), "{not json");
        let s: String = app_err("x.y", "").into();
        assert_eq!(s, r#"{"code":"x.y"}"#);
    }
}
