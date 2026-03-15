//! Djinn TLSNotary Prover CLI
//!
//! Performs a TLSNotary-attested HTTPS request to a target URL, then generates
//! a verifiable presentation with selective disclosure (API keys redacted).
//!
//! Usage:
//!   djinn-tlsn-prover \
//!     --url "https://api.the-odds-api.com/v4/sports/basketball_nba/odds?apiKey=KEY&regions=us&markets=spreads" \
//!     --notary-host 127.0.0.1 \
//!     --notary-port 7047 \
//!     --output /tmp/proof.bin
//!
//! The output file contains a bincode-serialized `Presentation` that any
//! verifier with the Notary's public key can independently check.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use futures::io::{AsyncReadExt as _, AsyncWriteExt as _};
use http_body_util::{BodyExt, Full};
use hyper::{body::Bytes, Method, Request, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt as TokioAsyncReadExt, AsyncWriteExt as TokioAsyncWriteExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tokio_util::compat::{FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};
use tracing::info;

use tlsn::{
    attestation::{
        presentation::Presentation,
        request::{Request as AttestationRequest, RequestConfig},
        Attestation, CryptoProvider,
    },
    config::{
        prove::ProveConfig,
        prover::ProverConfig,
        tls::TlsClientConfig,
        tls_commit::{mpc::MpcTlsConfig, TlsCommitConfig},
    },
    connection::{HandshakeData, ServerName},
    prover::ProverOutput,
    transcript::TranscriptCommitConfig,
    webpki::{CertificateDer, RootCertStore},
    Session,
};
use tlsn_formats::http::{DefaultHttpCommitter, HttpCommit, HttpTranscript};

use djinn_tlsn_tools::{MAX_RECV_DATA, MAX_SENT_DATA};

const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

#[derive(Parser, Debug)]
#[command(name = "djinn-tlsn-prover", about = "Generate TLSNotary proof for an HTTPS request")]
struct Args {
    /// Full URL to fetch (including query params)
    #[arg(long)]
    url: String,

    /// Notary server hostname (for direct TCP connection)
    #[arg(long, default_value = "127.0.0.1")]
    notary_host: String,

    /// Notary server port (for direct TCP connection)
    #[arg(long, default_value_t = 7047)]
    notary_port: u16,

    /// WebSocket URL for a remote notary (e.g. ws://1.2.3.4:8080/prover).
    /// When set, overrides --notary-host/--notary-port and connects via WebSocket.
    #[arg(long)]
    notary_ws_url: Option<String>,

    /// Output file path for the serialized presentation
    #[arg(long)]
    output: PathBuf,

    /// Headers to redact from the presentation (comma-separated, case-insensitive)
    #[arg(long, default_value = "authorization,apikey,x-api-key")]
    redact_headers: String,

    /// Max bytes the MPC circuit allocates for sent data (request body + headers).
    /// Must match or exceed the actual request size.
    #[arg(long, default_value_t = MAX_SENT_DATA)]
    max_sent_data: usize,

    /// Max bytes the MPC circuit allocates for received data.
    /// Must match or exceed the actual response size.
    #[arg(long, default_value_t = MAX_RECV_DATA)]
    max_recv_data: usize,

    /// HTTP method (GET, POST, PUT, etc.)
    #[arg(long, default_value = "GET")]
    method: String,

    /// Request body (for POST/PUT). Can also be read from --body-file.
    #[arg(long)]
    body: Option<String>,

    /// Path to a file containing the request body
    #[arg(long)]
    body_file: Option<PathBuf>,

    /// Extra headers to include (comma-separated key:value pairs)
    /// e.g. "Content-Type:application/json,x-api-key:sk-ant-..."
    #[arg(long)]
    headers: Option<String>,

    /// Path to save the HTTP response body (for extracting API results)
    #[arg(long)]
    response_output: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    // Parse the URL to extract host, port, path
    let url: hyper::Uri = args.url.parse().context("invalid URL")?;
    let host = url.host().context("URL must have a host")?.to_string();
    let port = url.port_u16().unwrap_or(443);
    let path = url
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/")
        .to_string();

    let redact_set: Vec<String> = args
        .redact_headers
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .collect();

    // Connect to the Notary server via WebSocket or TCP.
    // Both paths produce a DuplexStream so the Session type is uniform.
    let (local, remote) = tokio::io::duplex(256 * 1024);

    if let Some(ref ws_url) = args.notary_ws_url {
        info!("Connecting to notary via WebSocket: {}", ws_url);

        let (ws_stream, _) = connect_async(ws_url)
            .await
            .context("failed to connect to notary WebSocket")?;

        let (remote_read, remote_write) = tokio::io::split(remote);
        let (ws_sink, ws_recv) = futures::StreamExt::split(ws_stream);

        // WS recv -> remote_write (what Session reads)
        tokio::spawn({
            let mut ws_recv = ws_recv;
            let mut remote_write = remote_write;
            async move {
                use futures::StreamExt;
                while let Some(msg) = ws_recv.next().await {
                    match msg {
                        Ok(Message::Binary(data)) => {
                            if remote_write.write_all(&data).await.is_err() {
                                break;
                            }
                        }
                        Ok(Message::Close(_)) | Err(_) => break,
                        _ => {}
                    }
                }
            }
        });

        // remote_read -> WS sink (what Session writes)
        tokio::spawn({
            let mut remote_read = remote_read;
            let mut ws_sink = ws_sink;
            async move {
                use futures::SinkExt;
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match remote_read.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            if ws_sink
                                .send(Message::Binary(buf[..n].to_vec().into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        });
    } else {
        info!("Connecting to notary at {}:{}", args.notary_host, args.notary_port);

        let notary_socket =
            tokio::net::TcpStream::connect((args.notary_host.as_str(), args.notary_port))
                .await
                .context("failed to connect to notary server")?;

        // Bridge TCP <-> DuplexStream bidirectionally
        let mut notary_socket = notary_socket;
        let mut remote = remote;
        tokio::spawn(async move {
            tokio::io::copy_bidirectional(&mut notary_socket, &mut remote).await.ok();
        });
    }

    let session = Session::new(local.compat());
    let (driver, mut handle) = session.split();
    let driver_task = tokio::spawn(driver);

    // Create a new prover.
    let prover = handle
        .new_prover(ProverConfig::builder().build()?)?
        .commit(
            TlsCommitConfig::builder()
                .protocol(
                    MpcTlsConfig::builder()
                        .max_sent_data(args.max_sent_data)
                        .max_recv_data(args.max_recv_data)
                        .build()?,
                )
                .build()?,
        )
        .await?;

    info!("Connecting to target server {}:{}", host, port);

    // Open TCP connection to the target server.
    let client_socket = tokio::net::TcpStream::connect((host.as_str(), port)).await?;

    // Load Mozilla's root CA bundle for verifying the target server's certificate.
    let roots: Vec<CertificateDer> = webpki_root_certs::TLS_SERVER_ROOT_CERTS
        .iter()
        .map(|cert| CertificateDer(cert.as_ref().to_vec()))
        .collect();

    // Bind prover to the server connection.
    let (tls_connection, prover_fut) = prover.connect(
        TlsClientConfig::builder()
            .server_name(ServerName::Dns(host.clone().try_into()?))
            .root_store(RootCertStore { roots })
            .build()?,
        client_socket.compat(),
    ).await?;
    let tls_connection = TokioIo::new(tls_connection.compat());

    let prover_task = tokio::spawn(prover_fut);

    // HTTP handshake over the TLS connection.
    let (mut request_sender, connection): (
        hyper::client::conn::http1::SendRequest<Full<Bytes>>,
        _,
    ) = hyper::client::conn::http1::handshake(tls_connection).await?;
    tokio::spawn(connection);

    // Read body from file or CLI arg
    let body_bytes: Bytes = if let Some(ref body_path) = args.body_file {
        Bytes::from(std::fs::read(body_path).context("failed to read body file")?)
    } else if let Some(ref body_str) = args.body {
        Bytes::from(body_str.clone())
    } else {
        Bytes::new()
    };

    let method: Method = args.method.parse().context("invalid HTTP method")?;

    // Build the HTTP request.
    let mut req_builder = Request::builder()
        .uri(&path)
        .method(&method)
        .header("Host", &host)
        .header("Accept", "*/*")
        .header("Accept-Encoding", "identity")
        .header("Connection", "close")
        .header("User-Agent", USER_AGENT);

    // Add custom headers
    if let Some(ref header_str) = args.headers {
        for pair in header_str.split(',') {
            if let Some((key, value)) = pair.split_once(':') {
                req_builder = req_builder.header(key.trim(), value.trim());
            }
        }
    }

    // Add Content-Length for non-empty bodies
    if !body_bytes.is_empty() {
        req_builder = req_builder.header("Content-Length", body_bytes.len().to_string());
    }

    let request = req_builder.body(Full::new(body_bytes))?;

    info!("Sending request to {}", host);

    let response: hyper::Response<hyper::body::Incoming> =
        request_sender.send_request(request).await?;
    let status = response.status();

    info!("Response status: {}", status);

    if status != StatusCode::OK {
        tracing::warn!("server returned non-200 status: {status}");
    }

    // Consume the response body so it's captured in the TLS transcript.
    let response_body_bytes = response.into_body().collect().await?.to_bytes();
    let response_body = String::from_utf8_lossy(&response_body_bytes).to_string();

    info!("Response body length: {} bytes", response_body.len());

    // Save response body to file if requested.
    if let Some(ref resp_path) = args.response_output {
        tokio::fs::write(resp_path, &response_body).await?;
        info!("Response body saved to {}", resp_path.display());
    }

    // Finalize prover.
    let mut prover = prover_task.await??;

    // Try HTTP-aware transcript commit (selective disclosure).
    // Fall back to full-reveal mode if HTTP parsing fails (e.g. chunked encoding).
    // Full-reveal uses the "reveal all" fast path which discloses the TLS key
    // directly instead of per-byte ZK proofs — O(1) instead of O(n) in response size.
    let http_transcript_result = HttpTranscript::parse(prover.transcript());
    let use_raw = http_transcript_result.is_err();
    if use_raw {
        info!("HTTP parsing failed, using full-reveal mode (fast path)");
    }

    let (request_config, disclosure_config) = if !use_raw {
        // HTTP-aware: selective disclosure with per-field hash commitments.
        let mut builder = TranscriptCommitConfig::builder(prover.transcript());
        DefaultHttpCommitter::default()
            .commit_transcript(&mut builder, http_transcript_result.as_ref().unwrap())?;
        let transcript_commit = builder.build()?;

        let mut req_builder = RequestConfig::builder();
        req_builder.transcript_commit(transcript_commit);
        let request_config = req_builder.build()?;

        let mut prove_builder = ProveConfig::builder(prover.transcript());
        if let Some(config) = request_config.transcript_commit() {
            prove_builder.transcript_commit(config.clone());
        }
        let disclosure_config = prove_builder.build()?;
        (request_config, disclosure_config)
    } else {
        // Raw full-reveal: commit entire transcript AND reveal all.
        // Having both reveal_all + commit triggers the is_reveal_all fast path
        // in prove_plaintext(): plaintext is verified via key disclosure (O(1))
        // instead of per-byte ZK circuits (O(n)). Hash commitments are still
        // created for the presentation, but cheaply — no garbled circuits.
        let mut commit_builder = TranscriptCommitConfig::builder(prover.transcript());
        commit_builder.commit_sent(&(0..prover.transcript().sent().len()))?;
        commit_builder.commit_recv(&(0..prover.transcript().received().len()))?;
        let transcript_commit = commit_builder.build()?;

        let mut req_builder = RequestConfig::builder();
        req_builder.transcript_commit(transcript_commit);
        let request_config = req_builder.build()?;

        let mut prove_builder = ProveConfig::builder(prover.transcript());
        if let Some(config) = request_config.transcript_commit() {
            prove_builder.transcript_commit(config.clone());
        }
        prove_builder.reveal_sent_all()?;
        prove_builder.reveal_recv_all()?;
        let disclosure_config = prove_builder.build()?;
        (request_config, disclosure_config)
    };

    let ProverOutput {
        transcript_commitments,
        transcript_secrets,
        ..
    } = prover.prove(&disclosure_config).await?;

    let prover_transcript = prover.transcript().clone();
    let tls_transcript = prover.tls_transcript().clone();
    prover.close().await?;

    // Build attestation request.
    let mut builder = AttestationRequest::builder(&request_config);
    builder
        .server_name(ServerName::Dns(host.try_into()?))
        .handshake_data(HandshakeData {
            certs: tls_transcript
                .server_cert_chain()
                .expect("server cert chain is present")
                .to_vec(),
            sig: tls_transcript
                .server_signature()
                .expect("server signature is present")
                .clone(),
            binding: tls_transcript.certificate_binding().clone(),
        })
        .transcript(prover_transcript.clone())
        .transcript_commitments(transcript_secrets.clone(), transcript_commitments.clone());

    let (request, secrets) = builder.build(&CryptoProvider::default())?;

    // Close session and reclaim socket.
    handle.close();
    let mut socket = driver_task.await??;

    // Send attestation request to notary.
    let request_bytes = bincode::serialize(&request)?;
    socket.write_all(&request_bytes).await?;
    socket.close().await?;

    // Receive attestation from notary (capped at 10 MB to prevent unbounded allocation).
    let mut attestation_bytes = Vec::new();
    const MAX_ATTESTATION_SIZE: u64 = 10 * 1024 * 1024;
    (&mut socket).take(MAX_ATTESTATION_SIZE).read_to_end(&mut attestation_bytes).await?;
    let attestation: Attestation = bincode::deserialize(&attestation_bytes)?;

    // Validate attestation.
    let provider = CryptoProvider::default();
    request.validate(&attestation, &provider)?;

    info!("Attestation received and validated. Building presentation...");

    // Build presentation — HTTP-aware selective disclosure or raw full disclosure.
    let mut proof_builder = secrets.transcript_proof_builder();

    if !use_raw {
        // HTTP-aware: selective disclosure with header redaction
        let http_transcript = HttpTranscript::parse(secrets.transcript())?;

        let req = &http_transcript.requests[0];
        proof_builder.reveal_sent(&req.without_data())?;
        proof_builder.reveal_sent(&req.request.target)?;

        for header in &req.headers {
            let name_lower = header.name.as_str().to_lowercase();
            if redact_set.iter().any(|r| name_lower.contains(r)) {
                proof_builder.reveal_sent(&header.without_value())?;
            } else {
                proof_builder.reveal_sent(header)?;
            }
        }

        let resp = &http_transcript.responses[0];
        proof_builder.reveal_recv(&resp.without_data())?;
        for header in &resp.headers {
            proof_builder.reveal_recv(header)?;
        }
        if let Some(body) = resp.body.as_ref() {
            proof_builder.reveal_recv(body)?;
        }
    } else {
        // Raw: reveal entire sent and received transcript
        proof_builder.reveal_sent(&(0..secrets.transcript().sent().len()))?;
        proof_builder.reveal_recv(&(0..secrets.transcript().received().len()))?;
    }

    let transcript_proof = proof_builder.build()?;

    let mut pres_builder = attestation.presentation_builder(&provider);
    pres_builder
        .identity_proof(secrets.identity_proof())
        .transcript_proof(transcript_proof);

    let presentation: Presentation = pres_builder.build()?;

    // Write presentation to output file.
    tokio::fs::write(&args.output, bincode::serialize(&presentation)?).await?;

    // Output JSON summary to stdout.
    let summary = serde_json::json!({
        "status": "success",
        "output": args.output.to_string_lossy(),
        "server": url.host().unwrap_or_default(),
        "response_status": status.as_u16(),
        "response_body_length": response_body.len(),
    });
    println!("{}", serde_json::to_string(&summary)?);

    Ok(())
}
