use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::accept_async;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::{
    self,
    client::{ServerCertVerified, ServerCertVerifier},
    Certificate, ClientConfig, Error as TlsError, ServerName,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchRequest {
    r#type: String,
    id: u64,
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    body_encoding: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchResponse {
    r#type: String,
    id: u64,
    status: u16,
    headers: HashMap<String, String>,
    body: Option<String>,
    body_encoding: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TcpOpenRequest {
    r#type: String,
    id: u64,
    host: String,
    port: u16,
    tls: Option<bool>,
    server_name: Option<String>,
    insecure: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TcpWriteRequest {
    r#type: String,
    id: u64,
    stream_id: u64,
    data: Option<String>,
    data_encoding: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TcpCloseRequest {
    r#type: String,
    id: u64,
    stream_id: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TcpOpenResponse {
    r#type: String,
    id: u64,
    stream_id: Option<u64>,
    ok: bool,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TcpWriteResponse {
    r#type: String,
    id: u64,
    ok: bool,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TcpDataMessage {
    r#type: String,
    stream_id: u64,
    data: String,
    data_encoding: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TcpCloseMessage {
    r#type: String,
    stream_id: u64,
    error: Option<String>,
}

struct NoVerifier;

impl ServerCertVerifier for NoVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &Certificate,
        _intermediates: &[Certificate],
        _server_name: &ServerName,
        _scts: &mut dyn Iterator<Item = &[u8]>,
        _ocsp_response: &[u8],
        _now: std::time::SystemTime,
    ) -> Result<ServerCertVerified, TlsError> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &Certificate,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::HandshakeSignatureValid, TlsError> {
        Ok(rustls::client::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &Certificate,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::HandshakeSignatureValid, TlsError> {
        Ok(rustls::client::HandshakeSignatureValid::assertion())
    }
}

fn make_tls_config(insecure: bool) -> Result<ClientConfig, String> {
    if insecure {
        let cfg = ClientConfig::builder()
            .with_safe_defaults()
            .with_custom_certificate_verifier(Arc::new(NoVerifier))
            .with_no_client_auth();
        return Ok(cfg);
    }

    let mut root_store = rustls::RootCertStore::empty();
    root_store.add_trust_anchors(webpki_roots::TLS_SERVER_ROOTS.iter().map(|ta| {
        rustls::OwnedTrustAnchor::from_subject_spki_name_constraints(
            ta.subject,
            ta.spki,
            ta.name_constraints,
        )
    }));

    let cfg = ClientConfig::builder()
        .with_safe_defaults()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    Ok(cfg)
}

enum StreamWriter {
    Plain(tokio::net::tcp::OwnedWriteHalf),
    Tls(tokio::io::WriteHalf<tokio_rustls::client::TlsStream<TcpStream>>),
}

fn decode_body(body: &Option<String>, encoding: &Option<String>) -> Result<Vec<u8>, String> {
    let Some(body) = body else { return Ok(Vec::new()); };
    match encoding.as_deref() {
        Some("base64") => general_purpose::STANDARD
            .decode(body)
            .map_err(|e| format!("base64 decode error: {e}")),
        Some("json") | Some("utf8") | None => Ok(body.as_bytes().to_vec()),
        Some(other) => Err(format!("unsupported body encoding: {other}")),
    }
}

fn encode_body(bytes: &[u8]) -> (Option<String>, Option<String>) {
    if bytes.is_empty() {
        return (None, None);
    }
    let b64 = general_purpose::STANDARD.encode(bytes);
    (Some(b64), Some("base64".to_string()))
}

fn header_map_from_hash(headers: &Option<HashMap<String, String>>) -> Result<HeaderMap, String> {
    let mut out = HeaderMap::new();
    if let Some(headers) = headers {
        for (k, v) in headers {
            let name = HeaderName::from_bytes(k.as_bytes())
                .map_err(|e| format!("invalid header name {k}: {e}"))?;
            let value = HeaderValue::from_str(v)
                .map_err(|e| format!("invalid header value {k}: {e}"))?;
            out.insert(name, value);
        }
    }
    Ok(out)
}

fn headers_to_hash(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (k, v) in headers.iter() {
        if let Ok(val) = v.to_str() {
            out.insert(k.as_str().to_string(), val.to_string());
        }
    }
    out
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr: SocketAddr = "127.0.0.1:5772".parse()?;
    let listener = TcpListener::bind(addr).await?;
    println!("WS proxy listening on ws://{addr}");

    loop {
        let (stream, _) = listener.accept().await?;
        tokio::spawn(async move {
            let ws_stream = match accept_async(stream).await {
                Ok(ws) => ws,
                Err(e) => {
                    eprintln!("WS accept error: {e}");
                    return;
                }
            };

            let (mut ws_tx, mut ws_rx) = ws_stream.split();
            let client = reqwest::Client::new();

            let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
            let out_tx_clone = out_tx.clone();

            let writer = tokio::spawn(async move {
                while let Some(msg) = out_rx.recv().await {
                    if ws_tx.send(Message::Text(msg)).await.is_err() {
                        break;
                    }
                }
            });

            let streams: Arc<Mutex<HashMap<u64, StreamWriter>>> =
                Arc::new(Mutex::new(HashMap::new()));
            let mut next_stream_id: u64 = 1;

            while let Some(msg) = ws_rx.next().await {
                let msg = match msg {
                    Ok(Message::Text(text)) => text,
                    Ok(Message::Binary(bin)) => String::from_utf8_lossy(&bin).to_string(),
                    Ok(Message::Close(_)) => break,
                    Ok(_) => continue,
                    Err(e) => {
                        eprintln!("WS recv error: {e}");
                        break;
                    }
                };

                let value: serde_json::Value = match serde_json::from_str(&msg) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("Bad JSON: {e}");
                        continue;
                    }
                };

                let msg_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

                if msg_type == "fetch" {
                    let req: FetchRequest = match serde_json::from_value(value) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("Bad fetch payload: {e}");
                            continue;
                        }
                    };

                    let method = req.method.clone().unwrap_or_else(|| "GET".to_string());
                    let method = match method.parse() {
                        Ok(m) => m,
                        Err(e) => {
                            let resp = FetchResponse {
                                r#type: "fetch".to_string(),
                                id: req.id,
                                status: 0,
                                headers: HashMap::new(),
                                body: None,
                                body_encoding: None,
                                error: Some(format!("invalid method: {e}")),
                            };
                            let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                            continue;
                        }
                    };

                    let headers = match header_map_from_hash(&req.headers) {
                        Ok(h) => h,
                        Err(e) => {
                            let resp = FetchResponse {
                                r#type: "fetch".to_string(),
                                id: req.id,
                                status: 0,
                                headers: HashMap::new(),
                                body: None,
                                body_encoding: None,
                                error: Some(e),
                            };
                            let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                            continue;
                        }
                    };

                    let body = match decode_body(&req.body, &req.body_encoding) {
                        Ok(b) => b,
                        Err(e) => {
                            let resp = FetchResponse {
                                r#type: "fetch".to_string(),
                                id: req.id,
                                status: 0,
                                headers: HashMap::new(),
                                body: None,
                                body_encoding: None,
                                error: Some(e),
                            };
                            let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                            continue;
                        }
                    };

                    let mut req_builder = client.request(method, req.url).headers(headers);
                    if !body.is_empty() {
                        req_builder = req_builder.body(body);
                    }

                    let resp = match req_builder.send().await {
                        Ok(r) => r,
                        Err(e) => {
                            let resp = FetchResponse {
                                r#type: "fetch".to_string(),
                                id: req.id,
                                status: 0,
                                headers: HashMap::new(),
                                body: None,
                                body_encoding: None,
                                error: Some(format!("fetch error: {e}")),
                            };
                            let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                            continue;
                        }
                    };

                    let status = resp.status().as_u16();
                    let headers_out = headers_to_hash(resp.headers());
                    let bytes = match resp.bytes().await {
                        Ok(b) => b.to_vec(),
                        Err(e) => {
                            let resp = FetchResponse {
                                r#type: "fetch".to_string(),
                                id: req.id,
                                status,
                                headers: headers_out,
                                body: None,
                                body_encoding: None,
                                error: Some(format!("read body error: {e}")),
                            };
                            let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                            continue;
                        }
                    };

                    let (body_out, body_encoding) = encode_body(&bytes);
                    let resp = FetchResponse {
                        r#type: "fetch".to_string(),
                        id: req.id,
                        status,
                        headers: headers_out,
                        body: body_out,
                        body_encoding,
                        error: None,
                    };

                    let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                    continue;
                }

                if msg_type == "tcp_open" {
                    let req: TcpOpenRequest = match serde_json::from_value(value) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("Bad tcp_open payload: {e}");
                            continue;
                        }
                    };

                    let addr = format!("{}:{}", req.host, req.port);
                    let stream = match TcpStream::connect(addr).await {
                        Ok(s) => s,
                        Err(e) => {
                            let resp = TcpOpenResponse {
                                r#type: "tcp_open".to_string(),
                                id: req.id,
                                stream_id: None,
                                ok: false,
                                error: Some(format!("connect error: {e}")),
                            };
                            let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                            continue;
                        }
                    };

                    let stream_id = next_stream_id;
                    next_stream_id += 1;
                    let use_tls = req.tls.unwrap_or(false);
                    let insecure = req.insecure.unwrap_or(false);

                    if use_tls {
                        let server_name = req
                            .server_name
                            .clone()
                            .unwrap_or_else(|| req.host.clone());
                        let server_name = match ServerName::try_from(server_name.as_str()) {
                            Ok(name) => name,
                            Err(e) => {
                                let resp = TcpOpenResponse {
                                    r#type: "tcp_open".to_string(),
                                    id: req.id,
                                    stream_id: None,
                                    ok: false,
                                    error: Some(format!("bad server name: {e}")),
                                };
                                let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                                continue;
                            }
                        };

                        let cfg = match make_tls_config(insecure) {
                            Ok(c) => c,
                            Err(e) => {
                                let resp = TcpOpenResponse {
                                    r#type: "tcp_open".to_string(),
                                    id: req.id,
                                    stream_id: None,
                                    ok: false,
                                    error: Some(e),
                                };
                                let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                                continue;
                            }
                        };

                        let connector = TlsConnector::from(Arc::new(cfg));
                        let tls_stream = match connector.connect(server_name, stream).await {
                            Ok(s) => s,
                            Err(e) => {
                                let resp = TcpOpenResponse {
                                    r#type: "tcp_open".to_string(),
                                    id: req.id,
                                    stream_id: None,
                                    ok: false,
                                    error: Some(format!("tls handshake error: {e}")),
                                };
                                let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                                continue;
                            }
                        };

                        let (mut reader, writer) = tokio::io::split(tls_stream);
                        streams.lock().await.insert(stream_id, StreamWriter::Tls(writer));

                        let out_tx_reader = out_tx_clone.clone();
                        let streams_reader = streams.clone();
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 16 * 1024];
                            loop {
                                match reader.read(&mut buf).await {
                                    Ok(0) => {
                                        let msg = TcpCloseMessage {
                                            r#type: "tcp_close".to_string(),
                                            stream_id,
                                            error: None,
                                        };
                                        let _ = out_tx_reader.send(serde_json::to_string(&msg).unwrap());
                                        streams_reader.lock().await.remove(&stream_id);
                                        break;
                                    }
                                    Ok(n) => {
                                        let data = general_purpose::STANDARD.encode(&buf[..n]);
                                        let msg = TcpDataMessage {
                                            r#type: "tcp_data".to_string(),
                                            stream_id,
                                            data,
                                            data_encoding: "base64".to_string(),
                                        };
                                        let _ = out_tx_reader.send(serde_json::to_string(&msg).unwrap());
                                    }
                                    Err(e) => {
                                        let msg = TcpCloseMessage {
                                            r#type: "tcp_close".to_string(),
                                            stream_id,
                                            error: Some(format!("read error: {e}")),
                                        };
                                        let _ = out_tx_reader.send(serde_json::to_string(&msg).unwrap());
                                        streams_reader.lock().await.remove(&stream_id);
                                        break;
                                    }
                                }
                            }
                        });
                    } else {
                        let (mut reader, writer) = stream.into_split();
                        streams.lock().await.insert(stream_id, StreamWriter::Plain(writer));

                        let out_tx_reader = out_tx_clone.clone();
                        let streams_reader = streams.clone();
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 16 * 1024];
                            loop {
                                match reader.read(&mut buf).await {
                                    Ok(0) => {
                                        let msg = TcpCloseMessage {
                                            r#type: "tcp_close".to_string(),
                                            stream_id,
                                            error: None,
                                        };
                                        let _ = out_tx_reader.send(serde_json::to_string(&msg).unwrap());
                                        streams_reader.lock().await.remove(&stream_id);
                                        break;
                                    }
                                    Ok(n) => {
                                        let data = general_purpose::STANDARD.encode(&buf[..n]);
                                        let msg = TcpDataMessage {
                                            r#type: "tcp_data".to_string(),
                                            stream_id,
                                            data,
                                            data_encoding: "base64".to_string(),
                                        };
                                        let _ = out_tx_reader.send(serde_json::to_string(&msg).unwrap());
                                    }
                                    Err(e) => {
                                        let msg = TcpCloseMessage {
                                            r#type: "tcp_close".to_string(),
                                            stream_id,
                                            error: Some(format!("read error: {e}")),
                                        };
                                        let _ = out_tx_reader.send(serde_json::to_string(&msg).unwrap());
                                        streams_reader.lock().await.remove(&stream_id);
                                        break;
                                    }
                                }
                            }
                        });
                    }

                    let resp = TcpOpenResponse {
                        r#type: "tcp_open".to_string(),
                        id: req.id,
                        stream_id: Some(stream_id),
                        ok: true,
                        error: None,
                    };
                    let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                    continue;
                }

                if msg_type == "tcp_write" {
                    let req: TcpWriteRequest = match serde_json::from_value(value) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("Bad tcp_write payload: {e}");
                            continue;
                        }
                    };

                    let data = match decode_body(&req.data, &req.data_encoding) {
                        Ok(b) => b,
                        Err(e) => {
                            let resp = TcpWriteResponse {
                                r#type: "tcp_write".to_string(),
                                id: req.id,
                                ok: false,
                                error: Some(e),
                            };
                            let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                            continue;
                        }
                    };

                    let mut guard = streams.lock().await;
                    let write_res = match guard.get_mut(&req.stream_id) {
                        Some(StreamWriter::Plain(writer)) => writer.write_all(&data).await,
                        Some(StreamWriter::Tls(writer)) => writer.write_all(&data).await,
                        None => {
                            let resp = TcpWriteResponse {
                                r#type: "tcp_write".to_string(),
                                id: req.id,
                                ok: false,
                                error: Some("unknown stream".to_string()),
                            };
                            let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                            continue;
                        }
                    };

                    if let Err(e) = write_res {
                        let resp = TcpWriteResponse {
                            r#type: "tcp_write".to_string(),
                            id: req.id,
                            ok: false,
                            error: Some(format!("write error: {e}")),
                        };
                        let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                        continue;
                    }

                    let resp = TcpWriteResponse {
                        r#type: "tcp_write".to_string(),
                        id: req.id,
                        ok: true,
                        error: None,
                    };
                    let _ = out_tx_clone.send(serde_json::to_string(&resp).unwrap());
                    continue;
                }

                if msg_type == "tcp_close" {
                    let req: TcpCloseRequest = match serde_json::from_value(value) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("Bad tcp_close payload: {e}");
                            continue;
                        }
                    };

                    streams.lock().await.remove(&req.stream_id);
                    let msg = TcpCloseMessage {
                        r#type: "tcp_close".to_string(),
                        stream_id: req.stream_id,
                        error: None,
                    };
                    let _ = out_tx_clone.send(serde_json::to_string(&msg).unwrap());
                    continue;
                }
            }

            let _ = writer.await;
        });
    }
}
