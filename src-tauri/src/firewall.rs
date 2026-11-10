//! Windows: can a phone reach phone sync, and the one-click fix.
//!
//! The usual reason a phone gets nothing from a Windows computer: the first
//! time Hivo opened its port, Windows asked "Allow access?", the window was
//! closed, and Windows quietly stored an inbound **Block** rule for Hivo's
//! exe. Or the Wi-Fi is marked **Public**, where no allow rule of Hivo's
//! applies.
//!
//! `check` reads (no admin) the network category of the interface carrying
//! the address the QR names first, whether the firewall is on for it, and
//! the inbound rules for Hivo's own exe; `assess` (pure, tested on every OS)
//! says whether the phone is blocked. `fix` asks Windows for admin rights
//! (one UAC prompt) and runs one script: drop Hivo's inbound Block rules
//! (except a Public-only one), add "Hivo phone sync" (TCP, this exe, local
//! subnet only, Private + Domain), and set that one interface to Private when
//! it was Public.
//!
//! Nothing here comes from the webview: the exe is `current_exe()`, the
//! address is this computer's own LAN address, both quoted as PowerShell
//! literals and passed with `-EncodedCommand`.

// The PowerShell side only runs on Windows; the rest is tested everywhere.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};

/// The rule `fix` adds (and replaces on a second run).
pub const RULE_NAME: &str = "Hivo phone sync";
pub const RULE_GROUP: &str = "Hivo";
/// What Start-Process exits with when the user says No to the UAC prompt
/// (ERROR_CANCELLED).
pub const EXIT_CANCELLED: i32 = 1223;

/// One enabled inbound rule for Hivo's exe, as PowerShell prints it.
#[derive(Debug, Deserialize)]
pub struct RawRule {
    pub action: String,
    /// "Any", "Private", "Domain, Private"…
    pub profile: String,
}

/// What the check script prints (`ConvertTo-Json`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// `NetConnectionProfile.NetworkCategory`: Public, Private, DomainAuthenticated.
    pub category: Option<String>,
    pub firewall_on: Option<bool>,
    #[serde(default)]
    pub rules: Vec<RawRule>,
}

#[derive(Debug, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FirewallState {
    /// False off Windows: nothing to check.
    pub supported: bool,
    /// The check couldn't tell (no LAN address, PowerShell failed).
    pub unknown: bool,
    /// The Wi-Fi is marked Public.
    pub public_network: bool,
    /// An inbound Block rule for Hivo applies on this network.
    pub blocked: bool,
    /// The phone can't get in: show "Fix it".
    pub needs_fix: bool,
}

impl FirewallState {
    #[cfg_attr(windows, allow(dead_code))]
    pub fn unsupported() -> Self {
        FirewallState::default()
    }
    pub fn unknown() -> Self {
        FirewallState { supported: true, unknown: true, ..Default::default() }
    }
}

/// The firewall profile a network category falls under.
fn profile_of(category: &str) -> Option<&'static str> {
    match category {
        "Public" => Some("Public"),
        "Private" => Some("Private"),
        "DomainAuthenticated" => Some("Domain"),
        _ => None,
    }
}

/// Whether a rule's profile list ("Domain, Private", "Any") covers `profile`.
fn covers(rule_profile: &str, profile: &str) -> bool {
    rule_profile.split(',').map(str::trim).any(|p| p.eq_ignore_ascii_case("Any") || p.eq_ignore_ascii_case(profile))
}

/// Blocked when a Block rule covers this network (it wins over any allow)
/// or no Allow rule does (Windows' default for an app is to block).
pub fn assess(probe: &Probe) -> FirewallState {
    let Some(profile) = probe.category.as_deref().and_then(profile_of) else {
        return FirewallState::unknown();
    };
    let public_network = profile == "Public";
    if probe.firewall_on == Some(false) {
        return FirewallState { supported: true, public_network, ..Default::default() };
    }
    let applies = |action: &str| probe.rules.iter().any(|r| r.action.eq_ignore_ascii_case(action) && covers(&r.profile, profile));
    let blocked = applies("Block");
    let allowed = applies("Allow");
    FirewallState { supported: true, unknown: false, public_network, blocked, needs_fix: blocked || !allowed }
}

/// A PowerShell single-quoted literal. PowerShell also reads the curly
/// single quotes as quotes, so those are doubled too.
pub fn ps_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
    out
}

/// `-EncodedCommand`: base64 of the UTF-16LE script.
pub fn encode_command(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The rules matching Hivo's exe (a rule may store the path with
/// environment variables, and Windows compares paths case-insensitively).
const HIVO_RULES: &str = "Get-NetFirewallApplicationFilter | Where-Object { [Environment]::ExpandEnvironmentVariables($_.Program) -ieq $exe } | Get-NetFirewallRule";

/// The read-only check (no admin). Prints one JSON line: `Probe`.
pub fn check_script(exe: &str, ip: &str) -> String {
    format!(
        "$ErrorActionPreference = 'SilentlyContinue'\n\
         $exe = {exe}; $ip = {ip}\n\
         $cat = $null; $on = $null\n\
         $idx = (Get-NetIPAddress -IPAddress $ip -AddressFamily IPv4 | Select-Object -First 1).InterfaceIndex\n\
         if ($idx) {{\n\
           $c = (Get-NetConnectionProfile -InterfaceIndex $idx | Select-Object -First 1).NetworkCategory\n\
           if ($null -ne $c) {{\n\
             $cat = [string]$c\n\
             $name = if ($cat -eq 'DomainAuthenticated') {{ 'Domain' }} else {{ $cat }}\n\
             $fp = Get-NetFirewallProfile -Name $name\n\
             if ($fp) {{ $on = ([string]$fp.Enabled) -eq 'True' }}\n\
           }}\n\
         }}\n\
         $rules = @({HIVO_RULES} | Where-Object {{ [string]$_.Enabled -eq 'True' -and [string]$_.Direction -eq 'Inbound' }} | ForEach-Object {{ @{{ action = [string]$_.Action; profile = [string]$_.Profile }} }})\n\
         ConvertTo-Json -Compress -Depth 3 -InputObject @{{ category = $cat; firewallOn = $on; rules = $rules }}\n",
        exe = ps_quote(exe),
        ip = ps_quote(ip),
    )
}

/// The fix, run as admin. Exits 0 when done, 2 on any error.
pub fn fix_script(exe: &str, ip: &str, make_private: bool) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         $exe = {exe}; $ip = {ip}\n\
         try {{\n\
           {HIVO_RULES} | Where-Object {{ [string]$_.Direction -eq 'Inbound' -and [string]$_.Action -eq 'Block' -and [string]$_.Profile -ne 'Public' }} | Remove-NetFirewallRule\n\
           Get-NetFirewallRule -Group {group} -ErrorAction SilentlyContinue | Remove-NetFirewallRule\n\
           New-NetFirewallRule -DisplayName {name} -Group {group} -Direction Inbound -Program $exe -Action Allow -Protocol TCP -RemoteAddress LocalSubnet -Profile Private,Domain | Out-Null\n\
           if (${private}) {{\n\
             $idx = (Get-NetIPAddress -IPAddress $ip -AddressFamily IPv4 | Select-Object -First 1).InterfaceIndex\n\
             Set-NetConnectionProfile -InterfaceIndex $idx -NetworkCategory Private\n\
           }}\n\
           exit 0\n\
         }} catch {{ exit 2 }}\n",
        exe = ps_quote(exe),
        ip = ps_quote(ip),
        name = ps_quote(RULE_NAME),
        group = ps_quote(RULE_GROUP),
        private = if make_private { "true" } else { "false" },
    )
}

/// Runs `inner` (already encoded) as admin through UAC and exits with its
/// exit code, or `EXIT_CANCELLED` when the user said No.
pub fn elevate_script(powershell: &str, inner_encoded: &str) -> String {
    format!(
        "try {{\n\
           $p = Start-Process -FilePath {ps} -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',{cmd}\n\
           exit $p.ExitCode\n\
         }} catch {{ exit {EXIT_CANCELLED} }}\n",
        ps = ps_quote(powershell),
        cmd = ps_quote(inner_encoded),
    )
}

#[cfg(windows)]
mod run {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// Windows PowerShell by its full path (never whatever `powershell` PATH finds).
    pub fn powershell() -> String {
        let root = std::env::var("SystemRoot").ok().filter(|r| !r.is_empty()).unwrap_or_else(|| r"C:\Windows".to_string());
        format!(r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe")
    }

    /// Runs a script hidden, at most `limit`. Exit code + stdout.
    pub fn run(script: &str, limit: Duration) -> Result<(i32, String), String> {
        let mut child = Command::new(powershell())
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encode_command(script)])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut stdout = child.stdout.take();
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(out) = stdout.as_mut() {
                use std::io::Read;
                let _ = out.read_to_string(&mut s);
            }
            s
        });
        let started = Instant::now();
        let status = loop {
            if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
                break s;
            }
            if started.elapsed() > limit {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out".to_string());
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let out = reader.join().unwrap_or_default();
        Ok((status.code().unwrap_or(-1), out))
    }
}

/// Hivo's exe as Windows knows it (no `\\?\` prefix: rules store plain paths).
#[cfg(windows)]
fn exe_path() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let s = exe.to_string_lossy().to_string();
    Ok(s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s))
}

/// Reads the state for the interface carrying `ip`. Blocking (PowerShell, a few seconds).
#[cfg(windows)]
pub fn check(ip: Option<std::net::Ipv4Addr>) -> FirewallState {
    let (Some(ip), Ok(exe)) = (ip, exe_path()) else {
        return FirewallState::unknown();
    };
    match run::run(&check_script(&exe, &ip.to_string()), std::time::Duration::from_secs(45)) {
        Ok((0, out)) => out
            .lines()
            .rev()
            .find_map(|l| serde_json::from_str::<Probe>(l.trim()).ok())
            .map(|p| assess(&p))
            .unwrap_or_else(FirewallState::unknown),
        _ => FirewallState::unknown(),
    }
}

#[cfg(not(windows))]
pub fn check(_ip: Option<std::net::Ipv4Addr>) -> FirewallState {
    FirewallState::unsupported()
}

pub enum FixOutcome {
    Done,
    /// No to the UAC prompt.
    Cancelled,
    Failed(String),
}

/// The fix through one UAC prompt. Blocking until the user answers and the script ran.
#[cfg(windows)]
pub fn fix(ip: std::net::Ipv4Addr, make_private: bool) -> FixOutcome {
    let exe = match exe_path() {
        Ok(e) => e,
        Err(e) => return FixOutcome::Failed(e),
    };
    let inner = encode_command(&fix_script(&exe, &ip.to_string(), make_private));
    // The UAC prompt waits for the user: give them time.
    match run::run(&elevate_script(&run::powershell(), &inner), std::time::Duration::from_secs(300)) {
        Ok((0, _)) => FixOutcome::Done,
        Ok((EXIT_CANCELLED, _)) => FixOutcome::Cancelled,
        Ok((code, _)) => FixOutcome::Failed(format!("exit code {code}")),
        Err(e) => FixOutcome::Failed(e),
    }
}

#[cfg(not(windows))]
pub fn fix(_ip: std::net::Ipv4Addr, _make_private: bool) -> FixOutcome {
    FixOutcome::Failed("only on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(category: Option<&str>, on: Option<bool>, rules: &[(&str, &str)]) -> Probe {
        Probe {
            category: category.map(str::to_string),
            firewall_on: on,
            rules: rules.iter().map(|(a, p)| RawRule { action: a.to_string(), profile: p.to_string() }).collect(),
        }
    }

    #[test]
    fn a_dismissed_prompt_blocks() {
        // What Windows stores when "Allow access?" is closed: Block on the current profile.
        let s = assess(&probe(Some("Private"), Some(true), &[("Block", "Private")]));
        assert!(s.blocked && s.needs_fix && !s.public_network);
    }

    #[test]
    fn no_rule_at_all_blocks() {
        assert!(assess(&probe(Some("Private"), Some(true), &[])).needs_fix);
    }

    #[test]
    fn an_allow_rule_for_this_network_is_enough() {
        let s = assess(&probe(Some("Private"), Some(true), &[("Allow", "Domain, Private"), ("Block", "Public")]));
        assert_eq!(s, FirewallState { supported: true, ..Default::default() });
        assert!(!assess(&probe(Some("Public"), Some(true), &[("Allow", "Any")])).needs_fix);
        assert!(!assess(&probe(Some("DomainAuthenticated"), Some(true), &[("Allow", "Domain")])).needs_fix);
    }

    #[test]
    fn block_wins_over_allow() {
        let s = assess(&probe(Some("Private"), Some(true), &[("Allow", "Private"), ("Block", "Any")]));
        assert!(s.blocked && s.needs_fix);
    }

    #[test]
    fn a_public_network_with_a_private_rule_needs_the_fix() {
        let s = assess(&probe(Some("Public"), Some(true), &[("Allow", "Private")]));
        assert!(s.public_network && s.needs_fix && !s.blocked);
    }

    #[test]
    fn firewall_off_or_unknown_network_never_asks() {
        assert!(!assess(&probe(Some("Public"), Some(false), &[("Block", "Any")])).needs_fix);
        let u = assess(&probe(None, None, &[]));
        assert!(u.unknown && !u.needs_fix);
        assert!(assess(&probe(Some("Weird"), Some(true), &[])).unknown);
    }

    #[test]
    fn probe_reads_powershell_json() {
        // ConvertTo-Json prints null for an unknown network and [] for no rules.
        let p: Probe = serde_json::from_str(r#"{"category":"Public","firewallOn":true,"rules":[{"action":"Block","profile":"Public"}]}"#).unwrap();
        assert!(assess(&p).needs_fix);
        let p: Probe = serde_json::from_str(r#"{"category":null,"firewallOn":null,"rules":[]}"#).unwrap();
        assert!(assess(&p).unknown);
    }

    #[test]
    fn quoting_cannot_break_out() {
        assert_eq!(ps_quote(r"C:\Users\O'Neil\Hivo.exe"), r"'C:\Users\O''Neil\Hivo.exe'");
        assert_eq!(ps_quote("a\u{2019}b"), "'a\u{2019}\u{2019}b'");
        let s = check_script("C:\\x';Remove-Item C:\\ -Recurse;'", "192.168.1.2");
        assert!(s.contains("$exe = 'C:\\x'';Remove-Item C:\\ -Recurse;'''"));
    }

    #[test]
    fn a_failed_profile_read_is_unknown_not_off() {
        // Review 2026-11-10: `$on` stays null when Get-NetFirewallProfile
        // fails, so the rules still decide instead of "firewall off".
        let s = check_script("C:\\Hivo\\Hivo.exe", "192.168.1.2");
        assert!(s.contains("if ($fp) { $on = ([string]$fp.Enabled) -eq 'True' }"));
        assert!(assess(&probe(Some("Private"), None, &[("Block", "Private")])).needs_fix);
    }

    #[test]
    fn encoded_command_is_utf16le_base64() {
        // "a" → 61 00 → "YQA="
        assert_eq!(encode_command("a"), "YQA=");
    }

    #[test]
    fn scripts_name_only_hivo_and_the_lan() {
        let f = fix_script(r"C:\Hivo\Hivo.exe", "192.168.1.20", true);
        assert!(f.contains("-RemoteAddress LocalSubnet -Profile Private,Domain"));
        assert!(f.contains("if ($true)"));
        assert!(f.contains("-ne 'Public'"), "a block on Public networks only is kept");
        assert!(fix_script("x", "y", false).contains("if ($false)"));
        let e = elevate_script(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe", "QUJD");
        assert!(e.contains("-Verb RunAs") && e.contains("'QUJD'") && e.contains(&format!("exit {EXIT_CANCELLED}")));
    }
}
