//! Stores the Postman API key. On macOS it goes in the Keychain; elsewhere it
//! falls back to a file readable only by the current user.

#[cfg(target_os = "macos")]
mod imp {
    const SERVICE: &str = "app.dispatch.client";
    const ACCOUNT: &str = "postman-api-key";

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
    }

    pub fn get(_dir: &std::path::Path) -> Result<Option<String>, String> {
        match entry()?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Couldn't read the key from Keychain: {e}")),
        }
    }

    pub fn set(_dir: &std::path::Path, value: &str) -> Result<(), String> {
        entry()?.set_password(value).map_err(|e| format!("Couldn't save the key to Keychain: {e}"))
    }

    pub fn delete(_dir: &std::path::Path) -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use std::path::{Path, PathBuf};

    fn path(dir: &Path) -> PathBuf {
        dir.join("postman-api-key")
    }

    pub fn get(dir: &Path) -> Result<Option<String>, String> {
        match std::fs::read_to_string(path(dir)) {
            Ok(v) => Ok(Some(v.trim().to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set(dir: &Path, value: &str) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let p = path(dir);
        std::fs::write(&p, value).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn delete(dir: &Path) -> Result<(), String> {
        match std::fs::remove_file(path(dir)) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub use imp::{delete, get, set};
