//! The fetch proxy at GET /fetch?url=: reads a public web page for the assistant when the site
//! blocks the browser (no CORS). Public http(s) addresses only, every hop checked and the
//! checked address dialled, no credentials, text types only, size, time and rate caps.

use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures::{Stream, StreamExt};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::json;
use tokio::net::TcpListener;
use url::{Host, Url};

use crate::netaddr::is_blocked_address;
use crate::util::js_format;

pub const MAX_BYTES: usize = 2 * 1024 * 1024;
pub const TIMEOUT_MS: u64 = 15_000;
pub const PER_MINUTE: u32 = 30;
pub const MAX_REDIRECTS: usize = 5;
pub const USER_AGENT: &str = concat!("RebeLLM/", env!("CARGO_PKG_VERSION"), " (+https://rebellm.ai)");
const ACCEPT: &str =
    "text/html,application/xhtml+xml,application/xml;q=0.9,text/*;q=0.8,application/json;q=0.8,*/*;q=0.1";
const ACCEPT_ENCODING: &str = "gzip, deflate, br";

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type Body = Pin<Box<dyn Stream<Item = Result<Bytes, String>> + Send>>;

/// An address resolved for a host name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub address: String,
    pub family: u8,
}

/// Resolves a host name to addresses; none when it does not resolve.
pub trait Lookup: Send + Sync {
    fn lookup<'a>(&'a self, host: &'a str) -> BoxFuture<'a, Vec<Resolved>>;
}

/// The upstream response handed back to the client.
pub struct Upstream {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Body,
}

/// Dials a checked address, keeping the URL's host as Host header and TLS name.
pub trait Dial: Send + Sync {
    fn dial<'a>(
        &'a self,
        url: &'a Url,
        to: &'a Resolved,
        headers: &'a [(&'static str, &'static str)],
    ) -> BoxFuture<'a, Result<Upstream, String>>;
}

struct SystemLookup;

impl Lookup for SystemLookup {
    fn lookup<'a>(&'a self, host: &'a str) -> BoxFuture<'a, Vec<Resolved>> {
        Box::pin(async move {
            match tokio::net::lookup_host((host, 0)).await {
                Ok(addrs) => addrs
                    .map(|a| Resolved {
                        address: a.ip().to_string(),
                        family: if a.is_ipv4() { 4 } else { 6 },
                    })
                    .collect(),
                Err(_) => Vec::new(),
            }
        })
    }
}

/// Requests a URL from the given, already checked address: the URL's host name stays the
/// Host header and the TLS server name, and no second lookup can swap the address.
pub struct SystemDial;

impl Dial for SystemDial {
    fn dial<'a>(
        &'a self,
        url: &'a Url,
        to: &'a Resolved,
        headers: &'a [(&'static str, &'static str)],
    ) -> BoxFuture<'a, Result<Upstream, String>> {
        Box::pin(async move {
            let mut builder = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy();
            if let Some(Host::Domain(name)) = url.host() {
                let ip: IpAddr = to
                    .address
                    .parse()
                    .map_err(|_| format!("{} is not an address", to.address))?;
                builder = builder.resolve(name, SocketAddr::new(ip, 0));
            }
            let client = builder.build().map_err(|e| e.to_string())?;
            let mut request = client.get(url.clone());
            for (name, value) in headers {
                // The client asks for the encodings it can decode itself.
                if *name != "accept-encoding" {
                    request = request.header(*name, *value);
                }
            }
            let response = request.send().await.map_err(|e| error_chain(&e))?;
            let headers = response
                .headers()
                .iter()
                .map(|(k, v)| {
                    (
                        k.as_str().to_string(),
                        String::from_utf8_lossy(v.as_bytes()).into_owned(),
                    )
                })
                .collect();
            Ok(Upstream {
                status: response.status().as_u16(),
                headers,
                body: Box::pin(response.bytes_stream().map(|c| c.map_err(|e| error_chain(&e)))),
            })
        })
    }
}

/// An error with its causes: reqwest's own text names only the URL.
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut text = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        text = format!("{text}: {s}");
        source = s.source();
    }
    text
}

/// What the proxy answers its client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| *k == name).map(|(_, v)| v.as_str())
    }

    /// The `error` of a JSON error body.
    pub fn error(&self) -> Option<String> {
        let v: serde_json::Value = serde_json::from_slice(&self.body).ok()?;
        v.get("error")?.as_str().map(str::to_string)
    }
}

fn fail(status: u16, error: impl Into<String>) -> Reply {
    Reply {
        status,
        headers: vec![
            ("content-type", "application/json".into()),
            ("cache-control", "no-store".into()),
            ("x-content-type-options", "nosniff".into()),
        ],
        body: json!({ "error": error.into() }).to_string().into_bytes(),
    }
}

struct HttpError(u16, String);

fn parse_target(raw: &str) -> Result<Url, HttpError> {
    let mut u = Url::parse(raw).map_err(|_| HttpError(400, "not a URL".into()))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err(HttpError(400, format!("only http and https, not {}:", u.scheme())));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(HttpError(400, "URLs with credentials are not fetched".into()));
    }
    u.set_fragment(None);
    Ok(u)
}

/// `text/*`, `application/json`, `application/xml` and the `+json` and `+xml` types.
fn is_text_type(t: &str) -> bool {
    let word = |s: &str, extra: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || extra.contains(c))
    };
    if let Some(sub) = t.strip_prefix("text/") {
        return word(sub, ".+-");
    }
    let Some(sub) = t.strip_prefix("application/") else {
        return false;
    };
    if sub == "json" || sub == "xml" {
        return true;
    }
    match sub.rsplit_once('+') {
        Some((name, suffix)) => word(name, ".-") && (suffix == "json" || suffix == "xml"),
        None => false,
    }
}

/// The client's address: the first X-Forwarded-For hop (the reverse proxy sets it), else the socket's.
pub fn client_key(forwarded_for: Option<&str>, remote: Option<&str>) -> String {
    let first = forwarded_for.unwrap_or("").split(',').next().unwrap_or("").trim();
    if !first.is_empty() {
        return first.to_string();
    }
    remote.filter(|r| !r.is_empty()).unwrap_or("?").to_string()
}

pub struct FetchProxy {
    pub dial: Arc<dyn Dial>,
    pub lookup: Arc<dyn Lookup>,
    pub max_bytes: usize,
    pub timeout_ms: u64,
    pub per_minute: u32,
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// Per client: the tokens left and when they were counted.
    buckets: Mutex<HashMap<String, (f64, u64)>>,
}

impl Default for FetchProxy {
    fn default() -> Self {
        Self::new(Arc::new(SystemDial), Arc::new(SystemLookup))
    }
}

impl FetchProxy {
    pub fn new(dial: Arc<dyn Dial>, lookup: Arc<dyn Lookup>) -> Self {
        Self {
            dial,
            lookup,
            max_bytes: MAX_BYTES,
            timeout_ms: TIMEOUT_MS,
            per_minute: PER_MINUTE,
            now: Arc::new(crate::util::now_ms),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    fn take(&self, key: &str) -> bool {
        let t = (self.now)();
        let full = f64::from(self.per_minute);
        let rate = full / 60_000.0;
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        // Full buckets carry no state; drop them once the map grows.
        if buckets.len() > 10_000 {
            buckets.retain(|k, (tokens, at)| k == key || *tokens + (t - *at) as f64 * rate < full);
        }
        let b = buckets.entry(key.to_string()).or_insert((full, t));
        b.0 = full.min(b.0 + (t - b.1) as f64 * rate);
        b.1 = t;
        if b.0 < 1.0 {
            return false;
        }
        b.0 -= 1.0;
        true
    }

    async fn resolve(&self, url: &Url) -> Result<Resolved, HttpError> {
        let (host, addrs) = match url.host() {
            Some(Host::Ipv4(a)) => (
                a.to_string(),
                vec![Resolved {
                    address: a.to_string(),
                    family: 4,
                }],
            ),
            Some(Host::Ipv6(a)) => (
                a.to_string(),
                vec![Resolved {
                    address: a.to_string(),
                    family: 6,
                }],
            ),
            Some(Host::Domain(name)) => (name.to_string(), self.lookup.lookup(name).await),
            None => (String::new(), Vec::new()),
        };
        if addrs.is_empty() {
            return Err(HttpError(502, format!("{host} does not resolve")));
        }
        if addrs.iter().any(|a| is_blocked_address(&a.address)) {
            return Err(HttpError(403, format!("{host} is a private address")));
        }
        Ok(addrs.into_iter().next().expect("not empty"))
    }

    async fn exchange(&self, target: &str) -> Result<Reply, HttpError> {
        let mut url = parse_target(target)?;
        let mut hop = 0;
        loop {
            let to = self.resolve(&url).await?;
            // Nothing of the client's request goes upstream: no cookies, no authorization.
            let headers = [
                ("user-agent", USER_AGENT),
                ("accept", ACCEPT),
                ("accept-encoding", ACCEPT_ENCODING),
            ];
            let up = self
                .dial
                .dial(&url, &to, &headers)
                .await
                .map_err(|e| HttpError(502, format!("could not fetch: {e}")))?;
            let header = |name: &str| {
                up.headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(name))
                    .map(|(_, v)| v.as_str())
            };
            if let (true, Some(location)) = (matches!(up.status, 301 | 302 | 303 | 307 | 308), header("location")) {
                if hop == MAX_REDIRECTS {
                    return Err(HttpError(502, format!("more than {MAX_REDIRECTS} redirects")));
                }
                let next = url.join(location).map_err(|_| HttpError(400, "not a URL".into()))?;
                url = parse_target(next.as_str())?;
                hop += 1;
                continue;
            }
            let content_type = header("content-type").unwrap_or("").to_string();
            let mut base = vec![
                ("x-final-url", url.as_str().to_string()),
                ("cache-control", "no-store".to_string()),
                ("x-content-type-options", "nosniff".to_string()),
                // Opened in a tab, the page must not run on the app's origin.
                ("content-security-policy", "default-src 'none'; sandbox".to_string()),
            ];
            if !(200..=299).contains(&up.status) {
                let status = if (400..=599).contains(&up.status) {
                    up.status
                } else {
                    502
                };
                return Ok(Reply {
                    status,
                    headers: base,
                    body: Vec::new(),
                });
            }
            let kind = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            if !is_text_type(&kind) {
                let named = if kind.is_empty() { "no content type" } else { &kind };
                return Err(HttpError(415, format!("{named} is not a text type")));
            }
            let too_big = || {
                let mb = self.max_bytes as f64 / f64::from(1 << 20);
                HttpError(502, format!("the page is larger than {} MB", js_format(mb)))
            };
            if header("content-length")
                .and_then(|v| v.trim().parse::<f64>().ok())
                .is_some_and(|n| n > self.max_bytes as f64)
            {
                return Err(too_big());
            }
            let mut body = Vec::new();
            let mut stream = up.body;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| HttpError(502, format!("could not fetch: {e}")))?;
                if body.len() + chunk.len() > self.max_bytes {
                    return Err(too_big());
                }
                body.extend_from_slice(&chunk);
            }
            base.push(("content-type", content_type));
            return Ok(Reply {
                status: 200,
                headers: base,
                body,
            });
        }
    }

    /// Answers one request: `target` is its path and query.
    pub async fn handle(&self, method: &str, target: &str, forwarded_for: Option<&str>, remote: Option<&str>) -> Reply {
        let Ok(q) = Url::parse(&format!("http://proxy{target}")) else {
            return fail(404, "not found");
        };
        if q.path() != "/fetch" {
            return fail(404, "not found");
        }
        if method != "GET" {
            return fail(405, "GET only");
        }
        let target = q.query_pairs().find(|(k, _)| k == "url").map(|(_, v)| v.into_owned());
        let Some(target) = target.filter(|t| !t.is_empty()) else {
            return fail(400, "url is missing");
        };
        if !self.take(&client_key(forwarded_for, remote)) {
            return fail(429, "too many requests; try again in a minute");
        }
        match tokio::time::timeout(Duration::from_millis(self.timeout_ms), self.exchange(&target)).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(HttpError(status, message))) => fail(status, message),
            Err(_) => fail(
                504,
                format!("no answer within {} s", js_format(self.timeout_ms as f64 / 1000.0)),
            ),
        }
    }
}

/// Serves the proxy on `listener` until the task is dropped.
pub async fn serve(listener: TcpListener, proxy: Arc<FetchProxy>) {
    loop {
        let Ok((socket, remote)) = listener.accept().await else {
            continue;
        };
        let proxy = proxy.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req: Request<Incoming>| {
                let proxy = proxy.clone();
                async move {
                    let target = req.uri().path_and_query().map_or("/", |p| p.as_str()).to_string();
                    let forwarded = req
                        .headers()
                        .get("x-forwarded-for")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string);
                    let remote = remote.ip().to_string();
                    let reply = proxy
                        .handle(req.method().as_str(), &target, forwarded.as_deref(), Some(&remote))
                        .await;
                    let mut response = Response::builder().status(reply.status);
                    for (name, value) in &reply.headers {
                        response = response.header(*name, value);
                    }
                    response.body(Full::new(Bytes::from(reply.body)))
                }
            });
            // A client that goes away drops the service, and the upstream request with it.
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(socket), service)
                .await;
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    fn public() -> Resolved {
        Resolved {
            address: "93.184.215.14".into(),
            family: 4,
        }
    }

    #[derive(Clone, Default)]
    struct Page {
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: Vec<&'static str>,
    }

    fn page(status: u16, headers: &[(&'static str, &str)], body: &[&'static str]) -> Page {
        Page {
            status,
            headers: headers.iter().map(|(k, v)| (*k, v.to_string())).collect(),
            body: body.to_vec(),
        }
    }

    fn text(content_type: &'static str, body: &[&'static str]) -> Page {
        page(200, &[("content-type", content_type)], body)
    }

    struct Call {
        url: String,
        address: String,
        family: u8,
        headers: Vec<(&'static str, &'static str)>,
    }

    /// A fake upstream: answers per URL, records every dial.
    #[derive(Default)]
    struct FakeUpstream {
        pages: HashMap<String, Page>,
        calls: Mutex<Vec<Call>>,
    }

    impl FakeUpstream {
        fn new(pages: &[(&str, Page)]) -> Arc<Self> {
            Arc::new(Self {
                pages: pages.iter().map(|(u, p)| (u.to_string(), p.clone())).collect(),
                calls: Mutex::new(Vec::new()),
            })
        }
        fn urls(&self) -> Vec<String> {
            self.calls.lock().unwrap().iter().map(|c| c.url.clone()).collect()
        }
    }

    impl Dial for FakeUpstream {
        fn dial<'a>(
            &'a self,
            url: &'a Url,
            to: &'a Resolved,
            headers: &'a [(&'static str, &'static str)],
        ) -> BoxFuture<'a, Result<Upstream, String>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(Call {
                    url: url.to_string(),
                    address: to.address.clone(),
                    family: to.family,
                    headers: headers.to_vec(),
                });
                let p = self.pages.get(url.as_str()).cloned().unwrap_or(page(404, &[], &[]));
                let chunks: Vec<Result<Bytes, String>> = p.body.iter().map(|c| Ok(Bytes::from(*c))).collect();
                Ok(Upstream {
                    status: p.status,
                    headers: p.headers.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
                    body: Box::pin(futures::stream::iter(chunks)),
                })
            })
        }
    }

    struct Table(HashMap<String, Vec<Resolved>>);

    impl Lookup for Table {
        fn lookup<'a>(&'a self, host: &'a str) -> BoxFuture<'a, Vec<Resolved>> {
            Box::pin(async move { self.0.get(host).cloned().unwrap_or_default() })
        }
    }

    /// Every name resolves to the public address.
    struct AllPublic;

    impl Lookup for AllPublic {
        fn lookup<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Vec<Resolved>> {
            Box::pin(async { vec![public()] })
        }
    }

    fn table(rows: &[(&str, Vec<Resolved>)]) -> Arc<Table> {
        Arc::new(Table(rows.iter().map(|(h, a)| (h.to_string(), a.clone())).collect()))
    }

    fn q(url: &str) -> String {
        format!(
            "/fetch?url={}",
            url::form_urlencoded::byte_serialize(url.as_bytes()).collect::<String>()
        )
    }

    async fn get(proxy: &FetchProxy, target: &str) -> Reply {
        proxy.handle("GET", target, None, Some("127.0.0.1")).await
    }

    #[tokio::test]
    async fn a_public_page_comes_back_with_its_type_the_final_url_and_no_store_the_checked_address_is_dialled() {
        let up = FakeUpstream::new(&[(
            "https://example.com/docs",
            text("text/html; charset=utf-8", &["<h1>", "Docs</h1>"]),
        )]);
        let proxy = FetchProxy::new(up.clone(), table(&[("example.com", vec![public()])]));
        let r = get(&proxy, &q("https://example.com/docs#part")).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"<h1>Docs</h1>");
        assert_eq!(r.header("content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(r.header("x-final-url"), Some("https://example.com/docs"));
        assert_eq!(r.header("cache-control"), Some("no-store"));
        assert_eq!(r.header("content-security-policy"), Some("default-src 'none'; sandbox"));
        assert_eq!(r.header("x-content-type-options"), Some("nosniff"));
        let calls = up.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].address, public().address);
        assert_eq!(calls[0].family, 4);
        // Nothing of the client's request is forwarded: the handler is not even given it.
        let mut names: Vec<&str> = calls[0].headers.iter().map(|(k, _)| *k).collect();
        names.sort();
        assert_eq!(names, ["accept", "accept-encoding", "user-agent"]);
        let ua = calls[0].headers.iter().find(|(k, _)| *k == "user-agent").unwrap().1;
        assert_eq!(ua, USER_AGENT);
        let version = ua
            .strip_prefix("RebeLLM/")
            .and_then(|s| s.strip_suffix(" (+https://rebellm.ai)"))
            .unwrap();
        assert_eq!(
            version.split('.').filter(|p| p.parse::<u32>().is_ok()).count(),
            3,
            "{ua}"
        );
    }

    #[tokio::test]
    async fn private_addresses_answer_403_without_connecting_also_when_only_one_address_or_a_redirect_is_private() {
        let up = FakeUpstream::new(&[(
            "https://good.example/",
            page(302, &[("location", "http://intranet.example/admin")], &[]),
        )]);
        let v4 = |a: &str| Resolved {
            address: a.into(),
            family: 4,
        };
        let lookup = table(&[
            ("localhost", vec![v4("127.0.0.1")]),
            ("mixed.example", vec![public(), v4("10.0.0.5")]),
            ("good.example", vec![public()]),
            ("intranet.example", vec![v4("192.168.1.1")]),
            (
                "v6.example",
                vec![Resolved {
                    address: "::ffff:169.254.169.254".into(),
                    family: 6,
                }],
            ),
        ]);
        let proxy = FetchProxy::new(up.clone(), lookup);
        for url in [
            "http://localhost:8080/",
            "http://mixed.example/",
            "http://192.168.1.1/",
            "http://[::1]/",
            "http://2130706433/",
            "http://v6.example/",
        ] {
            let r = get(&proxy, &q(url)).await;
            assert_eq!(r.status, 403, "{url}");
            assert!(r.error().unwrap().contains("private address"), "{url}");
            assert_eq!(r.header("x-final-url"), None);
        }
        assert_eq!(up.urls().len(), 0);
        let r = get(&proxy, &q("https://good.example/")).await;
        assert_eq!(r.status, 403);
        assert_eq!(r.error().as_deref(), Some("intranet.example is a private address"));
        assert_eq!(up.urls(), ["https://good.example/"]);
    }

    #[tokio::test]
    async fn redirects_are_followed_by_hand_up_to_five_times_relative_ones_too() {
        let mut pages = vec![
            (
                "http://a.example/".to_string(),
                page(301, &[("location", "/next")], &[]),
            ),
            (
                "http://a.example/next".to_string(),
                page(308, &[("location", "https://b.example/final")], &[]),
            ),
            ("https://b.example/final".to_string(), text("text/plain", &["done"])),
        ];
        for i in 0..7 {
            pages.push((
                format!("http://loop.example/{i}"),
                page(302, &[("location", &format!("/{}", i + 1))], &[]),
            ));
        }
        let pages: Vec<(&str, Page)> = pages.iter().map(|(u, p)| (u.as_str(), p.clone())).collect();
        let up = FakeUpstream::new(&pages);
        let proxy = FetchProxy::new(up.clone(), Arc::new(AllPublic));
        let r = get(&proxy, &q("http://a.example/")).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.header("x-final-url"), Some("https://b.example/final"));
        assert_eq!(r.body, b"done");
        let looped = get(&proxy, &q("http://loop.example/0")).await;
        assert_eq!(looped.status, 502);
        assert_eq!(looped.error().as_deref(), Some("more than 5 redirects"));
        assert_eq!(up.urls().iter().filter(|u| u.starts_with("http://loop")).count(), 6);
    }

    #[tokio::test]
    async fn only_http_and_https_urls_without_credentials() {
        let up = FakeUpstream::new(&[]);
        let proxy = FetchProxy::new(up.clone(), Arc::new(AllPublic));
        for (path, error) in [
            (q("file:///etc/passwd"), "only http and https, not file:"),
            (q("ftp://example.com/"), "only http and https, not ftp:"),
            (q("javascript:alert(1)"), "only http and https, not javascript:"),
            (
                q("https://user:pw@example.com/"),
                "URLs with credentials are not fetched",
            ),
            (q("nonsense"), "not a URL"),
            ("/fetch".to_string(), "url is missing"),
        ] {
            let r = get(&proxy, &path).await;
            assert_eq!(r.status, 400, "{path}");
            assert_eq!(r.body, json!({ "error": error }).to_string().into_bytes(), "{path}");
            assert_eq!(r.header("content-type"), Some("application/json"));
        }
        assert_eq!(up.urls().len(), 0);
    }

    #[tokio::test]
    async fn text_types_only_capped_in_size_an_upstream_error_status_is_passed_on() {
        let big_a: &'static str = Box::leak("a".repeat(60).into_boxed_str());
        let big_b: &'static str = Box::leak("b".repeat(60).into_boxed_str());
        let up = FakeUpstream::new(&[
            ("http://x.example/a.png", text("image/png", &["x"])),
            ("http://x.example/none", page(200, &[], &["x"])),
            ("http://x.example/ld", text("application/ld+json", &["{}"])),
            ("http://x.example/feed", text("application/atom+xml", &["<feed/>"])),
            ("http://x.example/big", text("text/plain", &[big_a, big_b])),
            (
                "http://x.example/said",
                page(
                    200,
                    &[("content-type", "text/plain"), ("content-length", "999")],
                    &["a"],
                ),
            ),
            (
                "http://x.example/gone",
                page(410, &[("content-type", "text/html")], &["<p>gone</p>"]),
            ),
        ]);
        let mut proxy = FetchProxy::new(up, Arc::new(AllPublic));
        proxy.max_bytes = 100;
        let r = get(&proxy, &q("http://x.example/a.png")).await;
        assert_eq!(r.status, 415);
        assert_eq!(r.error().as_deref(), Some("image/png is not a text type"));
        assert_eq!(get(&proxy, &q("http://x.example/none")).await.status, 415);
        let r = get(&proxy, &q("http://x.example/ld")).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.header("content-type"), Some("application/ld+json"));
        assert_eq!(get(&proxy, &q("http://x.example/feed")).await.status, 200);
        for p in ["big", "said"] {
            let r = get(&proxy, &q(&format!("http://x.example/{p}"))).await;
            assert_eq!(r.status, 502, "{p}");
            assert!(r.error().unwrap().contains("larger than"), "{p}");
        }
        let r = get(&proxy, &q("http://x.example/gone")).await;
        assert_eq!(r.status, 410);
        assert_eq!(r.header("x-final-url"), Some("http://x.example/gone"));
        assert!(r.body.is_empty());
    }

    struct Never;

    impl Dial for Never {
        fn dial<'a>(
            &'a self,
            _: &'a Url,
            _: &'a Resolved,
            _: &'a [(&'static str, &'static str)],
        ) -> BoxFuture<'a, Result<Upstream, String>> {
            Box::pin(std::future::pending())
        }
    }

    #[tokio::test]
    async fn the_whole_exchange_is_cut_at_the_time_limit() {
        let mut proxy = FetchProxy::new(Arc::new(Never), Arc::new(AllPublic));
        proxy.timeout_ms = 50;
        let r = get(&proxy, &q("http://slow.example/")).await;
        assert_eq!(r.status, 504);
        assert_eq!(
            r.body,
            json!({ "error": "no answer within 0.05 s" }).to_string().into_bytes()
        );
    }

    #[tokio::test]
    async fn a_token_bucket_per_client_address_keyed_by_the_first_x_forwarded_for_hop() {
        let t = Arc::new(AtomicU64::new(0));
        let up = FakeUpstream::new(&[("http://x.example/", text("text/plain", &["ok"]))]);
        let mut proxy = FetchProxy::new(up, Arc::new(AllPublic));
        proxy.per_minute = 2;
        let clock = t.clone();
        proxy.now = Arc::new(move || clock.load(Ordering::SeqCst));
        let target = q("http://x.example/");
        let from = |ip: &str| format!("{ip}, 10.0.0.2");
        let status = |ip: &'static str| {
            let (proxy, target) = (&proxy, &target);
            async move { proxy.handle("GET", target, Some(&from(ip)), Some("127.0.0.1")).await }
        };
        assert_eq!(status("1.1.1.1").await.status, 200);
        assert_eq!(status("1.1.1.1").await.status, 200);
        let r = status("1.1.1.1").await;
        assert_eq!(r.status, 429);
        assert!(r.error().unwrap().contains("too many requests"));
        assert_eq!(status("2.2.2.2").await.status, 200);
        // Two per minute: one more after 30 s.
        t.fetch_add(30_000, Ordering::SeqCst);
        assert_eq!(status("1.1.1.1").await.status, 200);
        assert_eq!(status("1.1.1.1").await.status, 429);
        assert_eq!(client_key(None, Some("::1")), "::1");
        assert_eq!(client_key(Some(" 3.3.3.3 "), None), "3.3.3.3");
        assert_eq!(client_key(None, None), "?");
    }

    #[tokio::test]
    async fn other_paths_404_get_only() {
        let proxy = FetchProxy::new(FakeUpstream::new(&[]), Arc::new(AllPublic));
        assert_eq!(get(&proxy, "/other").await.status, 404);
        assert_eq!(get(&proxy, "/index.html").await.error().as_deref(), Some("not found"));
        let r = proxy.handle("POST", "/fetch?url=x", None, None).await;
        assert_eq!(r.status, 405);
        assert_eq!(r.error().as_deref(), Some("GET only"));
    }

    /// A one-request-per-connection HTTP server on loopback that records what it was asked.
    async fn origin(seen: Arc<Mutex<Vec<(String, String, String)>>>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let seen = seen.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        let n = socket.read(&mut buf).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        request.extend_from_slice(&buf[..n]);
                    }
                    let head = String::from_utf8_lossy(&request).to_string();
                    let path = head.split(' ').nth(1).unwrap_or("").to_string();
                    let field = |name: &str| {
                        head.lines()
                            .find_map(|l| {
                                l.split_once(": ")
                                    .filter(|(k, _)| k.eq_ignore_ascii_case(name))
                                    .map(|(_, v)| v.to_string())
                            })
                            .unwrap_or_default()
                    };
                    seen.lock()
                        .unwrap()
                        .push((field("host"), path.clone(), field("user-agent")));
                    let (extra, body): (&str, Vec<u8>) = if path == "/zipped" {
                        use std::io::Write;
                        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                        gz.write_all(b"unzipped text").unwrap();
                        ("content-encoding: gzip\r\n", gz.finish().unwrap())
                    } else {
                        ("", b"plain text".to_vec())
                    };
                    let head = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                });
            }
        });
        port
    }

    async fn read(up: Upstream) -> String {
        let mut body = up.body;
        let mut out = Vec::new();
        while let Some(chunk) = body.next().await {
            out.extend_from_slice(&chunk.unwrap());
        }
        String::from_utf8(out).unwrap()
    }

    #[tokio::test]
    async fn dial_connects_to_the_given_address_and_keeps_the_host_name_for_host() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let port = origin(seen.clone()).await;
        let to = Resolved {
            address: "127.0.0.1".into(),
            family: 4,
        };
        let headers = [("user-agent", USER_AGENT), ("accept-encoding", ACCEPT_ENCODING)];
        let url = Url::parse(&format!("http://site.invalid:{port}/p?q=1")).unwrap();
        let up = SystemDial.dial(&url, &to, &headers).await.unwrap();
        assert_eq!(up.status, 200);
        assert_eq!(read(up).await, "plain text");
        assert_eq!(
            seen.lock().unwrap()[0],
            (
                format!("site.invalid:{port}"),
                "/p?q=1".to_string(),
                USER_AGENT.to_string()
            )
        );
        let zipped = Url::parse(&format!("http://site.invalid:{port}/zipped")).unwrap();
        assert_eq!(
            read(SystemDial.dial(&zipped, &to, &headers).await.unwrap()).await,
            "unzipped text"
        );
    }

    #[tokio::test]
    async fn the_server_answers_over_http_with_the_handlers_status_headers_and_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve(listener, Arc::new(FetchProxy::default())));
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let r = client
            .get(format!("http://127.0.0.1:{port}/fetch"))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 400);
        assert_eq!(r.headers()["cache-control"], "no-store");
        assert_eq!(
            r.text().await.unwrap(),
            json!({ "error": "url is missing" }).to_string()
        );
        let private = format!("http://127.0.0.1:{port}/fetch?url=http%3A%2F%2F127.0.0.1%2F");
        assert_eq!(client.get(private).send().await.unwrap().status(), 403);
    }

    #[test]
    fn text_types() {
        for t in [
            "text/html",
            "text/x.y+z-1",
            "application/json",
            "application/xml",
            "application/ld+json",
            "application/atom+xml",
        ] {
            assert!(is_text_type(t), "{t}");
        }
        for t in [
            "",
            "image/png",
            "text/",
            "application/octet-stream",
            "application/+json",
            "application/x+yaml",
            "text/a b",
        ] {
            assert!(!is_text_type(t), "{t}");
        }
    }
}
