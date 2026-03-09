/// Shared utilities for the Djinn TLSNotary prover and verifier.
pub const MAX_SENT_DATA: usize = 8192;
pub const MAX_RECV_DATA: usize = 262_144; // 256 KB — covers Odds API JSON with headroom
