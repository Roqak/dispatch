//! Sends the user's HTTP requests natively, so there are no browser CORS limits.

use base64::Engine;
use reqwest::cookie::Jar;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    pub key: String,
    /// "text" or "file"
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub value: String,
    /// Absolute path when kind == "file"
    #[serde(default)]
    pub src: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum Body {
    None,
    Raw { content: String },
    Urlencoded { fields: Vec<KeyValue> },
    Formdata { fields: Vec<FormField> },
    File { path: String },
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default = "yes")]
    pub follow_redirects: bool,
    #[serde(default = "yes")]
    pub verify_ssl: bool,
    /// Full proxy URL; userinfo in the URL is used for proxy auth.
    #[serde(default)]
    pub proxy_url: Option<String>,
    /// Client certificate (PKCS#12/PFX or PEM with key) presented over TLS.
    #[serde(default)]
    pub client_cert: Option<ClientCert>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClientCert {
    /// Path to a .pfx/.p12 or a PEM file (cert and key concatenated).
    pub path: String,
    #[serde(default)]
    pub password: String,
}

fn default_timeout() -> u64 {
    30_000
}
fn yes() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings { timeout_ms: default_timeout(), follow_redirects: true, verify_ssl: true, proxy_url: None, client_cert: None }
    }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    pub body: Option<Body>,
    #[serde(default)]
    pub settings: Option<Settings>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IncomingResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<KeyValue>,
    pub url: String,
    pub content_type: String,
    /// Set when the body is valid UTF-8 text.
    pub body_text: Option<String>,
    /// Set when the body is binary (images, PDFs, ...).
    pub body_base64: Option<String>,
    pub size: usize,
    pub time_ms: u128,
}

pub struct HttpState {
    jar: std::sync::RwLock<Arc<Jar>>,
}

impl HttpState {
    pub fn new() -> Self {
        HttpState { jar: std::sync::RwLock::new(Arc::new(Jar::default())) }
    }

    fn jar(&self) -> Arc<Jar> {
        self.jar.read().map(|j| j.clone()).unwrap_or_else(|p| p.into_inner().clone())
    }

    /// Drops every stored cookie by replacing the jar.
    pub fn clear_cookies(&self) {
        if let Ok(mut j) = self.jar.write() {
            *j = Arc::new(Jar::default());
        }
    }
}

const USER_AGENT: &str = concat!("Dispatch/", env!("CARGO_PKG_VERSION"));

pub async fn send(state: &HttpState, req: OutgoingRequest) -> Result<IncomingResponse, String> {
    let settings = req.settings.unwrap_or_default();
    let redirect = if settings.follow_redirects {
        reqwest::redirect::Policy::limited(10)
    } else {
        reqwest::redirect::Policy::none()
    };
    let mut client = reqwest::Client::builder()
        .cookie_provider(state.jar())
        .redirect(redirect)
        .danger_accept_invalid_certs(!settings.verify_ssl)
        .timeout(Duration::from_millis(settings.timeout_ms.max(1)))
        .user_agent(USER_AGENT)
        // native-tls (schannel on Windows, openssl on Linux, Security on macOS)
        // so client certificates work on all three platforms.
        .use_native_tls();
    if let Some(proxy_url) = settings.proxy_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        let proxy = reqwest::Proxy::all(proxy_url).map_err(|e| format!("Bad proxy URL: {e}"))?;
        client = client.proxy(proxy);
    }
    if let Some(cert) = &settings.client_cert {
        let bytes = read_cert_file(cert).await?;
        let identity = if cert.path.to_ascii_lowercase().ends_with(".p12") || cert.path.to_ascii_lowercase().ends_with(".pfx") {
            reqwest::Identity::from_pkcs12_der(&bytes, &cert.password)
                .map_err(|e| format!("Couldn't load the .pfx/.p12 certificate (wrong password?): {e}"))?
        } else {
            let (certs, key) = split_pem(&String::from_utf8_lossy(&bytes))
                .ok_or_else(|| "The PEM file must contain the certificate(s) and a private key.".to_string())?;
            reqwest::Identity::from_pkcs8_pem(certs.as_bytes(), key.as_bytes())
                .map_err(|e| format!("Couldn't load the PEM certificate ({e})"))?
        };
        client = client.identity(identity);
    }
    let client = client.build()
        .map_err(|e| format!("Could not set up the HTTP client: {e}"))?;

    let method = reqwest::Method::from_bytes(req.method.trim().to_uppercase().as_bytes())
        .map_err(|_| format!("\"{}\" isn't a valid HTTP method", req.method))?;

    let url = normalise_url(&req.url)?;
    let mut builder = client.request(method, url);

    for h in &req.headers {
        if h.key.trim().is_empty() {
            continue;
        }
        builder = builder.header(h.key.trim(), &h.value);
    }

    builder = match req.body.unwrap_or(Body::None) {
        Body::None => builder,
        Body::Raw { content } => builder.body(content),
        Body::Urlencoded { fields } => {
            let pairs: Vec<(String, String)> = fields.into_iter().map(|f| (f.key, f.value)).collect();
            builder.form(&pairs)
        }
        Body::Formdata { fields } => {
            let mut form = reqwest::multipart::Form::new();
            for f in fields {
                if f.kind == "file" {
                    let path = f.src.unwrap_or_default();
                    if path.is_empty() {
                        continue;
                    }
                    let bytes = tokio::fs::read(&path)
                        .await
                        .map_err(|e| format!("Couldn't read the file for \"{}\" ({path}): {e}", f.key))?;
                    let name = std::path::Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "file".into());
                    let mime = mime_guess::from_path(&path).first_or_octet_stream();
                    let part = reqwest::multipart::Part::bytes(bytes)
                        .file_name(name)
                        .mime_str(mime.as_ref())
                        .map_err(|e| e.to_string())?;
                    form = form.part(f.key, part);
                } else {
                    form = form.text(f.key, f.value);
                }
            }
            builder.multipart(form)
        }
        Body::File { path } => {
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|e| format!("Couldn't read the body file ({path}): {e}"))?;
            builder.body(bytes)
        }
    };

    let started = Instant::now();
    let resp = builder.send().await.map_err(describe_error)?;

    let status = resp.status();
    let final_url = resp.url().to_string();
    let headers: Vec<KeyValue> = resp
        .headers()
        .iter()
        .map(|(k, v)| KeyValue {
            key: k.to_string(),
            value: String::from_utf8_lossy(v.as_bytes()).to_string(),
        })
        .collect();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = resp.bytes().await.map_err(describe_error)?;
    let time_ms = started.elapsed().as_millis();
    let size = bytes.len();

    let (body_text, body_base64) = if looks_binary(&content_type) {
        (None, Some(base64::engine::general_purpose::STANDARD.encode(&bytes)))
    } else {
        match String::from_utf8(bytes.to_vec()) {
            Ok(s) => (Some(s), None),
            Err(_) => (None, Some(base64::engine::general_purpose::STANDARD.encode(&bytes))),
        }
    };

    Ok(IncomingResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        url: final_url,
        content_type,
        body_text,
        body_base64,
        size,
        time_ms,
    })
}

/// Splits a PEM file into its certificate blocks and its private-key block.
/// Accepts PKCS#8 ("PRIVATE KEY") and legacy PKCS#1 ("RSA PRIVATE KEY") keys.
pub fn split_pem(text: &str) -> Option<(String, String)> {
    let mut certs = Vec::new();
    let mut key = None;
    let mut block: Option<(String, String)> = None; // (label, body)
    let mut finish = |b: &mut Option<(String, String)>| {
        if let Some((label, body)) = b.take() {
            let full = format!("-----BEGIN {label}-----\n{body}-----END {label}-----\n");
            if label.contains("CERTIFICATE") {
                certs.push(full);
            } else if label.contains("PRIVATE KEY") {
                key = Some(full);
            }
        }
    };
    for line in text.lines() {
        let trim = line.trim();
        if let Some(rest) = trim.strip_prefix("-----BEGIN ") {
            if let Some(label) = rest.strip_suffix("-----") {
                finish(&mut block);
                block = Some((label.to_string(), String::new()));
            }
        } else if trim.starts_with("-----END ") {
            finish(&mut block);
        } else if let Some((_, body)) = block.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    finish(&mut block);
    if certs.is_empty() || key.is_none() {
        return None;
    }
    Some((certs.concat(), key.unwrap()))
}

/// Reads a client certificate file (PKCS#12 .pfx/.p12, or PEM with cert + key).
async fn read_cert_file(cert: &ClientCert) -> Result<Vec<u8>, String> {
    if cert.path.is_empty() {
        return Err("Pick a client certificate file or clear the field.".into());
    }
    tokio::fs::read(&cert.path)
        .await
        .map_err(|e| format!("Couldn't read the certificate file ({0}): {e}", cert.path))
}

/// Accept "example.com/x" the way Postman does, by assuming http://.
fn normalise_url(raw: &str) -> Result<reqwest::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter a URL to send the request to.".into());
    }
    if let Some(start) = trimmed.find("{{") {
        let name = trimmed[start + 2..].split("}}").next().unwrap_or("").trim();
        return Err(format!(
            "The URL uses {{{{{name}}}}}, which isn't defined. Select an environment that has it, or add it to the collection's variables."
        ));
    }
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("http://{trimmed}") };
    reqwest::Url::parse(&with_scheme).map_err(|e| format!("Couldn't read the URL \"{trimmed}\": {e}"))
}

fn looks_binary(content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    ct.starts_with("image/")
        || ct.starts_with("audio/")
        || ct.starts_with("video/")
        || ct.contains("application/pdf")
        || ct.contains("application/zip")
        || ct.contains("application/octet-stream")
}

fn describe_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        return "The request timed out. You can raise the timeout in Settings.".into();
    }
    if e.is_connect() {
        let mut msg = String::from("Couldn't connect to the server");
        if let Some(src) = std::error::Error::source(&e) {
            msg.push_str(&format!(": {src}"));
        }
        return msg;
    }
    if e.is_redirect() {
        return "Too many redirects. Turn off \"Follow redirects\" in Settings to see the first response.".into();
    }
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        msg.push_str(&format!(": {s}"));
        src = s.source();
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Minimal HTTP server: echoes the raw request back as the body.
    fn echo_server(reply_headers: &'static str, reply_body: Option<Vec<u8>>) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            for mut s in l.incoming().flatten().take(1) {
                let mut buf = vec![0u8; 65536];
                let mut got = Vec::new();
                s.set_read_timeout(Some(Duration::from_millis(300))).ok();
                while let Ok(n) = s.read(&mut buf) {
                    if n == 0 { break; }
                    got.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&got);
                    if let Some(i) = text.find("\r\n\r\n") {
                        let len = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if got.len() >= i + 4 + len { break; }
                    }
                }
                let body = reply_body.clone().unwrap_or(got);
                let head = format!("HTTP/1.1 201 Created\r\n{reply_headers}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                s.write_all(head.as_bytes()).unwrap();
                s.write_all(&body).unwrap();
            }
        });
        format!("http://{addr}")
    }

    fn req(url: String, method: &str, body: Option<Body>) -> OutgoingRequest {
        OutgoingRequest {
            method: method.into(),
            url,
            headers: vec![KeyValue { key: "X-Test".into(), value: "yes".into() }, KeyValue { key: " ".into(), value: "skipped".into() }],
            body,
            settings: None,
        }
    }

    #[tokio::test]
    async fn sends_method_headers_and_raw_body() {
        let url = echo_server("Content-Type: text/plain\r\n", None);
        let r = send(&HttpState::new(), req(format!("{url}/a?b=1"), "patch", Some(Body::Raw { content: "{\"x\":1}".into() }))).await.unwrap();
        assert_eq!(r.status, 201);
        assert_eq!(r.status_text, "Created");
        let echoed = r.body_text.unwrap();
        assert!(echoed.starts_with("PATCH /a?b=1 HTTP/1.1"), "{echoed}");
        assert!(echoed.to_lowercase().contains("x-test: yes"));
        assert!(echoed.ends_with("{\"x\":1}"));
        assert!(echoed.contains("Dispatch/"));
    }

    #[tokio::test]
    async fn urlencoded_and_multipart() {
        let url = echo_server("", None);
        let r = send(&HttpState::new(), req(url, "POST", Some(Body::Urlencoded { fields: vec![KeyValue { key: "a b".into(), value: "c&d".into() }] }))).await.unwrap();
        let t = r.body_text.unwrap();
        assert!(t.contains("application/x-www-form-urlencoded"));
        assert!(t.ends_with("a+b=c%26d"), "{t}");

        let url = echo_server("", None);
        let f = FormField { key: "name".into(), kind: "text".into(), value: "Ada".into(), src: None };
        let r = send(&HttpState::new(), req(url, "POST", Some(Body::Formdata { fields: vec![f] }))).await.unwrap();
        let t = r.body_text.unwrap();
        assert!(t.contains("multipart/form-data; boundary="));
        assert!(t.contains("name=\"name\"") && t.contains("Ada"));
    }

    #[tokio::test]
    async fn binary_responses_are_base64() {
        let url = echo_server("Content-Type: image/png\r\n", Some(vec![0x89, b'P', b'N', b'G', 0, 1]));
        let r = send(&HttpState::new(), req(url, "GET", None)).await.unwrap();
        assert!(r.body_text.is_none());
        assert_eq!(r.body_base64.unwrap(), "iVBORwAB");
        assert_eq!(r.size, 6);
    }

    #[tokio::test]
    async fn friendly_errors() {
        let e = send(&HttpState::new(), req("{{baseUrl}}/x".into(), "GET", None)).await.unwrap_err();
        assert!(e.contains("{{baseUrl}}, which isn't defined"), "{e}");
        let e = send(&HttpState::new(), req("".into(), "GET", None)).await.unwrap_err();
        assert!(e.contains("Enter a URL"));
        let e = send(&HttpState::new(), req("http://127.0.0.1:1".into(), "GET", None)).await.unwrap_err();
        assert!(e.starts_with("Couldn't connect"), "{e}");
        let e = send(&HttpState::new(), req("http://x".into(), "BAD METHOD", None)).await.unwrap_err();
        assert!(e.contains("valid HTTP method"));
    }

    #[test]
    fn url_without_scheme_gets_http() {
        assert_eq!(normalise_url("example.com/a").unwrap().as_str(), "http://example.com/a");
        assert_eq!(normalise_url(" https://x.io ").unwrap().as_str(), "https://x.io/");
    }
}

#[cfg(test)]
mod pem_tests {
    use super::split_pem;

    #[test]
    fn splits_certificate_chain_and_key() {
        let text = "extra text\n-----BEGIN CERTIFICATE-----\nAAA\nBBB\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nCCC\n-----END CERTIFICATE-----\nnoise\n-----BEGIN PRIVATE KEY-----\nKKK\n-----END PRIVATE KEY-----\ntrailing\n";
        let (certs, key) = split_pem(text).unwrap();
        assert!(certs.contains("AAA") && certs.contains("CCC"));
        assert_eq!(certs.matches("-----BEGIN").count(), 2);
        assert!(key.contains("KKK"));
    }

    #[test]
    fn accepts_legacy_rsa_key_blocks() {
        let text = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n-----BEGIN RSA PRIVATE KEY-----\nRRR\n-----END RSA PRIVATE KEY-----\n";
        let (_, key) = split_pem(text).unwrap();
        assert!(key.contains("-----BEGIN RSA PRIVATE KEY-----"));
        assert!(key.contains("RRR"));
    }

    #[test]
    fn rejects_files_without_key_or_cert() {
        assert!(split_pem("-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n").is_none());
        assert!(split_pem("-----BEGIN RSA PRIVATE KEY-----\nRRR\n-----END RSA PRIVATE KEY-----\n").is_none());
        assert!(split_pem("nothing here").is_none());
    }
}
