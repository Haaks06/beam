// Same spirit as lib/sniffImageType.js, for the wider item types added in
// Phase 1d: a client-declared Content-Type/mimetype is trivially spoofed,
// so this checks the actual bytes on disk against each allowed format's
// real magic number, same as photos already do.

function sniffDocMime(buf) {
  // PDF: literal "%PDF-" at the very start of the file.
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') {
    return 'application/pdf';
  }
  // ZIP (and anything ZIP-based, including .docx/.xlsx/.pptx — the Office
  // Open XML formats are themselves ZIP containers under the hood, so this
  // can only confirm "a valid ZIP", not distinguish a plain .zip from a
  // .docx without inspecting the archive's own internal file listing,
  // which is out of scope here). "PK\x05\x06" is an empty archive's
  // end-of-central-directory-only form; "PK\x07\x08" is a spanned/split
  // archive's data-descriptor marker — both real, valid ZIP signatures.
  if (buf.length >= 4) {
    const sig = buf.toString('latin1', 0, 4);
    if (sig === 'PK\x03\x04' || sig === 'PK\x05\x06' || sig === 'PK\x07\x08') {
      return 'application/zip';
    }
  }
  // Legacy binary .doc (OLE2/Compound File Binary Format) — same magic
  // number as old .xls/.ppt, but this allowlist only maps it to .doc.
  if (
    buf.length >= 8 &&
    buf[0] === 0xd0 &&
    buf[1] === 0xcf &&
    buf[2] === 0x11 &&
    buf[3] === 0xe0 &&
    buf[4] === 0xa1 &&
    buf[5] === 0xb1 &&
    buf[6] === 0x1a &&
    buf[7] === 0xe1
  ) {
    return 'application/msword';
  }
  return null;
}

function sniffAudioMime(buf) {
  // WebM/Matroska container (MediaRecorder's default output in Chrome and
  // Firefox) — starts with the EBML header.
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return 'audio/webm';
  }
  // Ogg (Firefox's other common MediaRecorder output, and standalone Opus/
  // Vorbis files) — literal "OggS" at the start of each page.
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') {
    return 'audio/ogg';
  }
  // WAV: RIFF container, "WAVE" form type at offset 8 — same structural
  // check as lib/sniffImageType.js's existing WEBP handling.
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    return 'audio/wav';
  }
  // M4A/MP4 audio (Safari's MediaRecorder output): ISO base media file
  // format container — 4-byte box size, then "ftyp", then a brand. Same
  // shape as lib/sniffImageType.js's HEIC check, different brand list.
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (['M4A ', 'M4B ', 'isom', 'mp42', 'mp41'].includes(brand)) {
      return 'audio/mp4';
    }
  }
  // MP3 has no single universal magic number: either an ID3v2 tag prefix
  // ("ID3") when present, or a bare MPEG frame sync otherwise — the frame
  // sync is 11 set bits (0xFFE.. through 0xFFF..), covering every MPEG
  // version/layer/bitrate combination rather than one exact byte pair.
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') {
    return 'audio/mpeg';
  }
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return 'audio/mpeg';
  }
  return null;
}

module.exports = { sniffDocMime, sniffAudioMime };
