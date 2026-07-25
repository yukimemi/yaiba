//! Wire protocol for a sync round.
//!
//! One bidirectional stream carries a three-message exchange that leaves
//! both sides holding the union of each other's writes:
//!
//! ```text
//!   dialer  ──── Hello { room, vv_a } ────▶  listener
//!           ◀─── Offer { vv_b, entries } ──          (what A is missing)
//!           ──── Push  { entries } ───────▶          (what B is missing)
//! ```
//!
//! Both directions travel in a single round trip because each side sends
//! its version vector before the other has to decide what to transmit.

use anyhow::{Context, Result, bail};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use yaiba_core::{Entry, VersionVector};

/// Frames larger than this are refused rather than allocated. A full
/// dataset of a few thousand tasks is well under a megabyte of JSON;
/// anything near the cap is a bug or a hostile peer.
const MAX_FRAME: usize = 32 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
pub struct Hello {
    /// Hex-encoded room key. Peers that don't share it are dropped
    /// before any data is exchanged.
    pub room: String,
    pub vv: VersionVector,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Offer {
    pub vv: VersionVector,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Push {
    pub entries: Vec<Entry>,
}

/// Length-prefixed JSON. JSON rather than a compact codec because sync
/// traffic is tiny and being able to read a capture during development
/// is worth more than the bytes.
pub async fn write_frame<T, W>(writer: &mut W, value: &T) -> Result<()>
where
    T: Serialize,
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;
    let bytes = serde_json::to_vec(value).context("encode frame")?;
    if bytes.len() > MAX_FRAME {
        bail!("frame too large to send: {} bytes", bytes.len());
    }
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await?;
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

pub async fn read_frame<T, R>(reader: &mut R) -> Result<T>
where
    T: DeserializeOwned,
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut len = [0u8; 4];
    reader.read_exact(&mut len).await.context("read length")?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        bail!("peer announced an oversized frame: {len} bytes");
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await.context("read body")?;
    serde_json::from_slice(&buf).context("decode frame")
}

/// Constant-time-ish comparison of the shared room key.
///
/// The room key is the only authorisation in the protocol, so the
/// comparison must not leak where two keys diverge. `subtle` would be
/// the rigorous answer; for a 32-byte key over a network round trip this
/// fold is enough to remove the timing signal.
pub fn room_matches(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_round_trip() {
        let hello = Hello {
            room: "abc".into(),
            vv: VersionVector::new(),
        };
        let mut buf = Vec::new();
        write_frame(&mut buf, &hello).await.unwrap();

        let mut cursor = std::io::Cursor::new(buf);
        let back: Hello = read_frame(&mut cursor).await.unwrap();
        assert_eq!(back.room, "abc");
    }

    #[tokio::test]
    async fn an_oversized_length_prefix_is_refused_before_allocating() {
        let mut framed = Vec::new();
        framed.extend_from_slice(&u32::MAX.to_be_bytes());
        let mut cursor = std::io::Cursor::new(framed);
        let err = read_frame::<Hello, _>(&mut cursor).await.unwrap_err();
        assert!(err.to_string().contains("oversized"));
    }

    #[test]
    fn room_comparison_rejects_mismatches_and_length_changes() {
        assert!(room_matches("deadbeef", "deadbeef"));
        assert!(!room_matches("deadbeef", "deadbeee"));
        assert!(!room_matches("deadbeef", "deadbee"));
    }
}
