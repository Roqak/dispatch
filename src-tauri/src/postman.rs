//! Thin client for the public Postman API (https://api.postman.com, or the EU host).
//! Only documented endpoints are used, authenticated with the user's own API key.

use serde_json::Value;
use std::time::Duration;

/// Postman hosts EU-region accounts separately.
fn base(region: &str) -> &'static str {
    if region == "eu" { "https://api.eu.postman.com" } else { "https://api.postman.com" }
}

pub async fn call(api_key: &str, region: &str, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    if !path.starts_with('/') || path.contains("://") {
        return Err("Invalid Postman API path".into());
    }
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("Dispatch/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client
        .request(method, format!("{}{path}", base(region)))
        .header("X-Api-Key", api_key)
        .header("Accept", "application/json");
    if let Some(b) = body {
        req = req.json(&b);
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            "Couldn't reach Postman. Check your internet connection; your local copy is still available.".to_string()
        } else {
            format!("Postman request failed: {e}")
        }
    })?;

    let status = resp.status();
    let remaining = resp
        .headers()
        .get("x-ratelimit-remaining-month")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let mut json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

    if !status.is_success() {
        // Postman's error bodies come in a few shapes.
        let detail = ["/error/message", "/detail", "/message", "/title", "/error/name"]
            .iter()
            .find_map(|p| json.pointer(p).and_then(|v| v.as_str()))
            .map(|s| s.to_string())
            .unwrap_or_else(|| text.chars().take(300).collect());
        return Err(match status.as_u16() {
            401 => "Postman rejected the API key. Create a new one under Settings → API keys in Postman and paste it here.".into(),
            403 => format!("Your Postman account doesn't have permission for this: {detail}"),
            404 => format!("Postman couldn't find that item. It may have been deleted or moved: {detail}"),
            429 => "You've hit Postman's API rate limit. Wait a minute, or check your plan's monthly API limit.".into(),
            _ => format!("Postman returned {status}: {detail}"),
        });
    }

    if let (Some(r), Value::Object(map)) = (remaining, &mut json) {
        map.insert("_rateLimitRemainingMonth".into(), Value::String(r));
    }
    Ok(json)
}
