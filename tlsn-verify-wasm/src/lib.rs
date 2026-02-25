//! WASM TLSNotary proof verifier.
//!
//! Verifies TLSNotary `Presentation` files in the browser. This allows
//! client-side proof verification as a fallback when the validator cannot
//! verify the proof server-side.
//!
//! The verification checks:
//! 1. The notary's signature on the attestation is valid
//! 2. Transcript hash commitments match the disclosed data
//! 3. (Optionally) the server's TLS certificate chain is valid

use wasm_bindgen::prelude::*;

use tlsn_attestation::{
    presentation::{Presentation, PresentationOutput},
    CryptoProvider,
};

/// Verify a TLSNotary presentation and return JSON with the result.
///
/// # Arguments
/// * `proof_bytes` - The raw bytes of the serialized Presentation file.
///
/// # Returns
/// A JSON string with either:
/// - `{ "status": "verified", "server_name": "...", "response_body": "...", ... }`
/// - `{ "status": "failed", "error": "..." }`
#[wasm_bindgen]
pub fn verify_proof(proof_bytes: &[u8]) -> String {
    let presentation: Presentation = match bincode::deserialize(proof_bytes) {
        Ok(p) => p,
        Err(e) => {
            return serde_json::json!({
                "status": "failed",
                "error": format!("Failed to deserialize proof: {e}"),
            })
            .to_string();
        }
    };

    let verifying_key = presentation.verifying_key();
    let notary_key_hex = hex::encode(&verifying_key.data);
    let _ = verifying_key;

    let provider = CryptoProvider::default();

    match presentation.verify(&provider) {
        Ok(PresentationOutput {
            server_name,
            connection_info,
            transcript,
            ..
        }) => {
            let server_name = server_name
                .map(|s| s.to_string())
                .unwrap_or_default();

            let mut partial_transcript = transcript.unwrap();
            partial_transcript.set_unauthed(b'X');

            let _sent = String::from_utf8_lossy(partial_transcript.sent_unsafe()).to_string();
            let recv = String::from_utf8_lossy(partial_transcript.received_unsafe()).to_string();

            let body = recv
                .split("\r\n\r\n")
                .nth(1)
                .unwrap_or("")
                .to_string();

            serde_json::json!({
                "status": "verified",
                "server_name": server_name,
                "notary_key": notary_key_hex,
                "timestamp": connection_info.time,
                "response_body": body,
            })
            .to_string()
        }
        Err(e) => {
            serde_json::json!({
                "status": "failed",
                "error": format!("Verification failed: {e}"),
            })
            .to_string()
        }
    }
}
