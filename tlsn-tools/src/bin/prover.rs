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
use http_body_util::Empty;
use hyper::{body::Bytes, Request, StatusCode};
use hyper_util::rt::TokioIo;
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

    /// Notary server hostname
    #[arg(long, default_value = "127.0.0.1")]
    notary_host: String,

    /// Notary server port
    #[arg(long, default_value_t = 7047)]
    notary_port: u16,

    /// Output file path for the serialized presentation
    #[arg(long)]
    output: PathBuf,

    /// Headers to redact from the presentation (comma-separated, case-insensitive)
    #[arg(long, default_value = "authorization,apikey,x-api-key")]
    redact_headers: String,
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

    info!("Connecting to notary at {}:{}", args.notary_host, args.notary_port);

    // Connect to the Notary server via TCP.
    let notary_socket =
        tokio::net::TcpStream::connect((args.notary_host.as_str(), args.notary_port))
            .await
            .context("failed to connect to notary server")?;

    // Create a session with the notary.
    let session = Session::new(notary_socket.compat());
    let (driver, mut handle) = session.split();
    let driver_task = tokio::spawn(driver);

    // Create a new prover.
    let prover = handle
        .new_prover(ProverConfig::builder().build()?)?
        .commit(
            TlsCommitConfig::builder()
                .protocol(
                    MpcTlsConfig::builder()
                        .max_sent_data(MAX_SENT_DATA)
                        .max_recv_data(MAX_RECV_DATA)
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
        hyper::client::conn::http1::SendRequest<Empty<Bytes>>,
        _,
    ) = hyper::client::conn::http1::handshake(tls_connection).await?;
    tokio::spawn(connection);

    // Build the HTTP request.
    let request = Request::builder()
        .uri(&path)
        .header("Host", &host)
        .header("Accept", "application/json")
        .header("Accept-Encoding", "identity")
        .header("Connection", "close")
        .header("User-Agent", USER_AGENT)
        .body(Empty::<Bytes>::new())?;

    info!("Sending request to {}", host);

    let response: hyper::Response<hyper::body::Incoming> =
        request_sender.send_request(request).await?;
    let status = response.status();

    info!("Response status: {}", status);

    if status != StatusCode::OK {
        anyhow::bail!("server returned non-200 status: {status}");
    }

    // Finalize prover.
    let mut prover = prover_task.await??;

    // Parse HTTP transcript.
    let transcript = HttpTranscript::parse(prover.transcript())?;

    // Commit to transcript segments.
    let mut builder = TranscriptCommitConfig::builder(prover.transcript());
    DefaultHttpCommitter::default().commit_transcript(&mut builder, &transcript)?;
    let transcript_commit = builder.build()?;

    // Build attestation request config.
    let mut builder = RequestConfig::builder();
    builder.transcript_commit(transcript_commit);
    let request_config = builder.build()?;

    // Build prove config.
    let mut builder = ProveConfig::builder(prover.transcript());
    if let Some(config) = request_config.transcript_commit() {
        builder.transcript_commit(config.clone());
    }
    let disclosure_config = builder.build()?;

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

    // Receive attestation from notary.
    let mut attestation_bytes = Vec::new();
    socket.read_to_end(&mut attestation_bytes).await?;
    let attestation: Attestation = bincode::deserialize(&attestation_bytes)?;

    // Validate attestation.
    let provider = CryptoProvider::default();
    request.validate(&attestation, &provider)?;

    info!("Attestation received and validated. Building presentation...");

    // Build presentation with selective disclosure.
    let http_transcript = HttpTranscript::parse(secrets.transcript())?;
    let mut proof_builder = secrets.transcript_proof_builder();

    let req = &http_transcript.requests[0];
    // Reveal request structure and target.
    proof_builder.reveal_sent(&req.without_data())?;
    proof_builder.reveal_sent(&req.request.target)?;

    // Reveal headers, redacting sensitive ones.
    for header in &req.headers {
        let name_lower = header.name.as_str().to_lowercase();
        if redact_set.iter().any(|r| name_lower.contains(r)) {
            // Redact the value but reveal the header name.
            proof_builder.reveal_sent(&header.without_value())?;
        } else {
            proof_builder.reveal_sent(header)?;
        }
    }

    // Reveal full response (headers + body).
    let resp = &http_transcript.responses[0];
    proof_builder.reveal_recv(&resp.without_data())?;
    for header in &resp.headers {
        proof_builder.reveal_recv(header)?;
    }
    if let Some(body) = resp.body.as_ref() {
        proof_builder.reveal_recv(body)?;
    }

    let transcript_proof = proof_builder.build()?;

    let mut pres_builder = attestation.presentation_builder(&provider);
    pres_builder
        .identity_proof(secrets.identity_proof())
        .transcript_proof(transcript_proof);

    let presentation: Presentation = pres_builder.build()?;

    // Write presentation to output file.
    tokio::fs::write(&args.output, bincode::serialize(&presentation)?).await?;

    // Output JSON summary to stdout for the Python wrapper to parse.
    let summary = serde_json::json!({
        "status": "success",
        "output": args.output.to_string_lossy(),
        "server": url.host().unwrap_or_default(),
        "response_status": status.as_u16(),
    });
    println!("{}", serde_json::to_string(&summary)?);

    Ok(())
}
