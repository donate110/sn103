/// Shared utilities for the Djinn TLSNotary prover and verifier.
pub const MAX_SENT_DATA: usize = 524_288; // 512 KB — covers large API request bodies
pub const MAX_RECV_DATA: usize = 524_288; // 512 KB — covers web pages and API responses
