//! Djinn TLSNotary Verifier CLI
//!
//! Verifies a TLSNotary presentation file and outputs the disclosed data.
//!
//! Usage:
//!   djinn-tlsn-verifier --presentation /tmp/proof.bin
//!   djinn-tlsn-verifier --presentation /tmp/proof.bin --extra-roots /path/to/extra-roots.pem
//!
//! Outputs JSON to stdout with: server_name, timestamp, disclosed request/response.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;

use tlsn::attestation::{
    presentation::{Presentation, PresentationOutput},
    CryptoProvider,
};
use tlsn::webpki::{CertificateDer, RootCertStore, ServerCertVerifier};

#[derive(Parser, Debug)]
#[command(name = "djinn-tlsn-verifier", about = "Verify a TLSNotary presentation")]
struct Args {
    /// Path to the serialized presentation file
    #[arg(long)]
    presentation: PathBuf,

    /// Optional Notary public key (hex-encoded secp256k1). If not provided,
    /// accepts any valid signature (dev mode).
    #[arg(long)]
    notary_pubkey: Option<String>,

    /// Optional path to a PEM file containing additional root certificates.
    /// These are added to the default Mozilla root store. Useful for sites
    /// using CAs not yet in the Mozilla trust program (e.g. Cloudflare/SSL.com
    /// cross-signed chains).
    #[arg(long)]
    extra_roots: Option<PathBuf>,
}

/// Build a CryptoProvider with Mozilla roots plus any extra PEM root certs.
fn build_crypto_provider(extra_roots_path: Option<&PathBuf>) -> Result<CryptoProvider> {
    let mut root_store = RootCertStore::mozilla();

    if let Some(pem_path) = extra_roots_path {
        let pem_data = std::fs::read(pem_path)
            .with_context(|| format!("failed to read extra roots from {}", pem_path.display()))?;

        // Parse all PEM certificates from the file
        let mut count = 0;
        for pem in pem::parse_many(&pem_data)
            .map_err(|e| anyhow::anyhow!("failed to parse PEM: {}", e))?
        {
            if pem.tag() == "CERTIFICATE" {
                root_store.roots.push(CertificateDer(pem.contents().to_vec()));
                count += 1;
            }
        }
        eprintln!("[verifier] Loaded {} extra root certificate(s) from {}", count, pem_path.display());
    }

    let cert_verifier = ServerCertVerifier::new(&root_store)
        .map_err(|e| anyhow::anyhow!("failed to build cert verifier: {}", e))?;

    Ok(CryptoProvider {
        cert: cert_verifier,
        ..CryptoProvider::default()
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    let presentation_bytes = std::fs::read(&args.presentation)
        .with_context(|| format!("failed to read {}", args.presentation.display()))?;

    let presentation: Presentation = bincode::deserialize(&presentation_bytes)
        .context("failed to deserialize presentation")?;

    let crypto_provider = build_crypto_provider(args.extra_roots.as_ref())?;

    let verifying_key = presentation.verifying_key();
    let notary_key_hex = hex::encode(&verifying_key.data);
    let alg = verifying_key.alg.clone();

    // If a notary pubkey was specified, verify it matches.
    if let Some(expected_key) = &args.notary_pubkey {
        if notary_key_hex != *expected_key {
            let output = serde_json::json!({
                "status": "failed",
                "error": "notary public key mismatch",
                "expected": expected_key,
                "actual": notary_key_hex,
            });
            println!("{}", serde_json::to_string(&output)?);
            std::process::exit(1);
        }
    }
    // Release the borrow before consuming presentation
    let _ = verifying_key;

    // Verify the presentation.
    let result = presentation.verify(&crypto_provider);
    let output = match result {
        Ok(PresentationOutput {
            server_name,
            connection_info,
            transcript,
            ..
        }) => {
            let time =
                chrono::DateTime::UNIX_EPOCH + Duration::from_secs(connection_info.time);
            let server_name = server_name
                .map(|s| s.to_string())
                .unwrap_or_default();

            let mut partial_transcript = transcript.unwrap();
            partial_transcript.set_unauthed(b'X');

            let sent = String::from_utf8_lossy(partial_transcript.sent_unsafe()).to_string();
            let recv = String::from_utf8_lossy(partial_transcript.received_unsafe()).to_string();

            // Extract just the response body (after \r\n\r\n in received data).
            let body = recv
                .split("\r\n\r\n")
                .nth(1)
                .unwrap_or("")
                .to_string();

            serde_json::json!({
                "status": "verified",
                "server_name": server_name,
                "notary_key_alg": alg.to_string(),
                "notary_key": notary_key_hex,
                "connection_time": time.to_rfc3339(),
                "request": sent,
                "response_body": body,
                "response_full": recv,
            })
        }
        Err(e) => {
            serde_json::json!({
                "status": "failed",
                "error": e.to_string(),
            })
        }
    };

    println!("{}", serde_json::to_string_pretty(&output)?);

    if output["status"] == "failed" {
        std::process::exit(1);
    }

    Ok(())
}
