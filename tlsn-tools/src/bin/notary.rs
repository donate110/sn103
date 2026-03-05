//! Djinn TLSNotary Notary Server
//!
//! A lightweight notary server that signs TLSNotary attestations. Runs
//! alongside the miner and accepts raw TCP connections from the prover binary.
//!
//! Usage:
//!   djinn-tlsn-notary --port 7047 --key /path/to/notary-key.bin
//!
//! The signing key is a secp256k1 private key (32 raw bytes). If the file
//! does not exist, a new key is generated automatically. The corresponding
//! public key is printed at startup so validators can verify attestations.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use futures::io::{AsyncReadExt as _, AsyncWriteExt as _};
use k256::ecdsa::SigningKey;
use tokio_util::compat::TokioAsyncReadCompatExt;
use tracing::{error, info};

use tlsn::{
    attestation::{
        request::Request as AttestationRequest, signing::Secp256k1Signer, Attestation,
        AttestationConfig, CryptoProvider,
    },
    config::verifier::VerifierConfig,
    connection::{ConnectionInfo, TranscriptLength},
    transcript::ContentType,
    verifier::VerifierOutput,
    webpki::{CertificateDer, RootCertStore},
    Session,
};

#[derive(Parser, Debug)]
#[command(
    name = "djinn-tlsn-notary",
    about = "TLSNotary notary server for signing attestations"
)]
struct Args {
    /// TCP port to listen on
    #[arg(long, default_value_t = 7047)]
    port: u16,

    /// Bind address (default: 127.0.0.1 — use the WebSocket proxy for external access)
    #[arg(long, default_value = "127.0.0.1")]
    bind: String,

    /// Path to the secp256k1 signing key (32 raw bytes). Generated if missing.
    #[arg(long, default_value = "notary-key.bin")]
    key: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    let signing_key = load_or_generate_key(&args.key)?;
    let pubkey_hex = hex::encode(signing_key.verifying_key().to_sec1_bytes());
    info!(pubkey = %pubkey_hex, "Notary public key");

    let listener = tokio::net::TcpListener::bind((args.bind.as_str(), args.port)).await?;
    info!(bind = %args.bind, port = args.port, "Listening for connections");

    loop {
        let (socket, addr) = listener.accept().await?;
        info!(%addr, "New connection");
        let key = signing_key.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(socket, &key).await {
                error!(%addr, error = %e, "Connection failed");
            }
        });
    }
}

async fn handle_connection(
    socket: tokio::net::TcpStream,
    signing_key: &SigningKey,
) -> Result<()> {
    // Create a TLSNotary session with the prover.
    let session = Session::new(socket.compat());
    let (driver, mut handle) = session.split();
    let driver_task = tokio::spawn(driver);

    // Create a verifier (which acts as the notary in this protocol).
    // Load Mozilla's root CA bundle so we can verify any public TLS server.
    let roots: Vec<CertificateDer> = webpki_root_certs::TLS_SERVER_ROOT_CERTS
        .iter()
        .map(|cert| CertificateDer(cert.as_ref().to_vec()))
        .collect();
    let verifier_config = VerifierConfig::builder()
        .root_store(RootCertStore { roots })
        .build()?;

    let verifier = handle
        .new_verifier(verifier_config)?
        .commit()
        .await?
        .accept()
        .await?
        .run()
        .await?;

    // Run the MPC-TLS verification protocol.
    let (
        VerifierOutput {
            transcript_commitments,
            ..
        },
        verifier,
    ) = verifier.verify().await?.accept().await?;

    let tls_transcript = verifier.tls_transcript().clone();
    verifier.close().await?;

    // Compute application-data transcript lengths.
    let sent_len: usize = tls_transcript
        .sent()
        .iter()
        .filter_map(|r| match r.typ {
            ContentType::ApplicationData => Some(r.ciphertext.len()),
            _ => None,
        })
        .sum();
    let recv_len: usize = tls_transcript
        .recv()
        .iter()
        .filter_map(|r| match r.typ {
            ContentType::ApplicationData => Some(r.ciphertext.len()),
            _ => None,
        })
        .sum();

    // Close the session and reclaim the underlying socket.
    handle.close();
    let mut socket = driver_task.await??;

    // Read the attestation request from the prover (bincode-serialized).
    let mut request_bytes = Vec::new();
    socket.read_to_end(&mut request_bytes).await?;
    let request: AttestationRequest =
        bincode::deserialize(&request_bytes).context("failed to deserialize attestation request")?;

    info!(
        request_bytes = request_bytes.len(),
        "Received attestation request"
    );

    // Set up the signing provider.
    let signer = Box::new(Secp256k1Signer::new(&signing_key.to_bytes())?);
    let mut provider = CryptoProvider::default();
    provider.signer.set_signer(signer);

    // Build the attestation configuration.
    let att_config = AttestationConfig::builder()
        .supported_signature_algs(Vec::from_iter(provider.signer.supported_algs()))
        .build()?;

    // Build and sign the attestation.
    let mut builder = Attestation::builder(&att_config).accept_request(request)?;
    builder
        .connection_info(ConnectionInfo {
            time: tls_transcript.time(),
            version: *tls_transcript.version(),
            transcript_length: TranscriptLength {
                sent: sent_len as u32,
                received: recv_len as u32,
            },
        })
        .server_ephemeral_key(tls_transcript.server_ephemeral_key().clone())
        .transcript_commitments(transcript_commitments);

    let attestation = builder.build(&provider)?;

    // Send the signed attestation back to the prover (bincode-serialized).
    let attestation_bytes = bincode::serialize(&attestation)?;
    socket.write_all(&attestation_bytes).await?;
    socket.close().await?;

    info!(
        attestation_bytes = attestation_bytes.len(),
        "Attestation signed and sent"
    );

    Ok(())
}

fn load_or_generate_key(path: &PathBuf) -> Result<SigningKey> {
    if path.exists() {
        let bytes = std::fs::read(path).context("failed to read signing key")?;
        anyhow::ensure!(bytes.len() == 32, "signing key must be exactly 32 bytes");
        let key = SigningKey::from_bytes((&bytes[..]).into())
            .context("invalid secp256k1 signing key")?;
        info!(path = %path.display(), "Loaded signing key");
        Ok(key)
    } else {
        let key = SigningKey::random(&mut k256::elliptic_curve::rand_core::OsRng);
        std::fs::write(path, key.to_bytes()).context("failed to write signing key")?;
        info!(path = %path.display(), "Generated new signing key");
        Ok(key)
    }
}
