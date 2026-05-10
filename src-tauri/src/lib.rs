use fast_image_resize::images::Image as FirImage;
use fast_image_resize::{PixelType, ResizeAlg, ResizeOptions, Resizer};
use image::{DynamicImage, ImageFormat};
use sha2::{Digest, Sha256};
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::Manager;

#[derive(Serialize, Deserialize, Default)]
struct ImageMetadata {
    f_number: Option<String>,
    exposure_time: Option<String>,
    iso: Option<String>,
    focal_length: Option<String>,
    camera_model: Option<String>,
    lens_model: Option<String>,
    dimensions: Option<String>,
    camera_maker: Option<String>,
    exposure_bias: Option<String>,
    exposure_program: Option<String>,
    metering_mode: Option<String>,
    flash_mode: Option<String>,
    date_taken: Option<String>,
    white_balance: Option<String>,
    software: Option<String>,
    exposure_mode: Option<String>,
}

static THUMB_DIR: OnceLock<PathBuf> = OnceLock::new();

fn thumb_dir() -> &'static PathBuf {
    THUMB_DIR.get().expect("thumbnail cache directory not initialised")
}

// ── Stage 1: try to pull the EXIF-embedded JPEG thumbnail ────────────────────
// Camera-produced JPEGs always contain a small pre-rendered thumbnail in their
// EXIF/APP1 header (typically 160×120 or 320×240 pixels).  Extracting it means
// reading only the first ~60 KB of the file — no pixel decoding at all.
//
// We return the raw JPEG bytes of the embedded thumbnail when found.
fn try_exif_thumbnail(path: &str) -> Option<Vec<u8>> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(&file);

    // Parse the EXIF block (reads only the APP1 marker; very fast).
    let exif = exif::Reader::new()
        .read_from_container(&mut reader)
        .ok()?;

    // IFD1 holds the thumbnail sub-image.  Offset + length tags tell us exactly
    // where the embedded JPEG lives inside the file.
    let offset_field = exif.get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?;
    let length_field =
        exif.get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?;

    let offset = offset_field.value.get_uint(0)?;
    let length = length_field.value.get_uint(0)?;

    if length == 0 {
        return None;
    }

    // The EXIF block begins after the JPEG SOI (2 bytes) and APP1 marker+length
    // (4 bytes) — total 6 bytes.  The thumbnail offset is relative to the start
    // of the TIFF/EXIF block, which starts at byte 12 of the JPEG file
    // (SOI=2 + APP1 marker=2 + APP1 length=2 + "Exif\0\0"=6 = 12).
    let tiff_start: u64 = 12;
    let abs_offset = tiff_start + offset as u64;

    let mut buf = vec![0u8; length as usize];
    reader.seek(SeekFrom::Start(abs_offset)).ok()?;
    reader.read_exact(&mut buf).ok()?;

    // Sanity-check: must begin with JPEG SOI marker (0xFF 0xD8)
    if buf.len() >= 2 && buf[0] == 0xFF && buf[1] == 0xD8 {
        Some(buf)
    } else {
        None
    }
}

// ── Stage 2: full decode + SIMD resize (fallback) ────────────────────────────
// Used only when no EXIF thumbnail exists (e.g. phone screenshots, PNG files).
// Uses fast_image_resize for SIMD-accelerated downscaling — much faster than
// image::resize() for large source images.
fn decode_and_resize(path: &str, max_size: u32) -> Result<Vec<u8>, String> {
    let img = image::open(path)
        .map_err(|e| format!("Failed to open '{}': {}", path, e))?;

    let src_w = img.width();
    let src_h = img.height();

    // Compute target dimensions preserving aspect ratio
    let (dst_w, dst_h) = if src_w >= src_h {
        let h = (max_size as f32 * src_h as f32 / src_w as f32).round() as u32;
        (max_size, h.max(1))
    } else {
        let w = (max_size as f32 * src_w as f32 / src_h as f32).round() as u32;
        (w.max(1), max_size)
    };

    // fast_image_resize v5 takes plain u32 dimensions
    let rgb = img.to_rgb8();
    let src_image = FirImage::from_vec_u8(
        src_w,
        src_h,
        rgb.into_raw(),
        PixelType::U8x3,
    )
    .map_err(|e| e.to_string())?;

    let mut dst_image = FirImage::new(dst_w, dst_h, PixelType::U8x3);

    let mut resizer = Resizer::new();
    resizer
        .resize(
            &src_image,
            &mut dst_image,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(
                fast_image_resize::FilterType::Bilinear,
            )),
        )
        .map_err(|e| e.to_string())?;

    let img_buf = image::RgbImage::from_raw(dst_w, dst_h, dst_image.into_vec())
        .ok_or("Failed to wrap resized buffer")?;
    let dyn_img = DynamicImage::ImageRgb8(img_buf);
    let mut jpeg_bytes = Vec::new();
    dyn_img
        .write_to(&mut Cursor::new(&mut jpeg_bytes), ImageFormat::Jpeg)
        .map_err(|e| format!("JPEG encode failed: {}", e))?;

    Ok(jpeg_bytes)
}

// ── Main thumbnail pipeline ───────────────────────────────────────────────────
fn ensure_thumbnail(source_path: &str, max_size: u32) -> Result<PathBuf, String> {
    let cache_key = format!("{}:{}", max_size, source_path);
    let mut hasher = Sha256::new();
    hasher.update(cache_key.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let thumb_path = thumb_dir().join(format!("{}.jpg", hash));

    if thumb_path.exists() {
        return Ok(thumb_path); // already cached — instant return
    }

    // Stage 1: try the embedded EXIF thumbnail (near-instant for camera shots)
    let jpeg_bytes = if let Some(exif_bytes) = try_exif_thumbnail(source_path) {
        // The embedded thumbnail is usually already small enough (160-320px).
        // Decode it just to verify, then re-save (preserves correct dimensions).
        let tiny = image::load_from_memory_with_format(&exif_bytes, ImageFormat::Jpeg)
            .map_err(|e| format!("Failed to decode EXIF thumbnail: {}", e))?;

        if tiny.width() >= max_size / 2 || tiny.height() >= max_size / 2 {
            // It's big enough to look decent; use as-is
            exif_bytes
        } else {
            // Embedded thumbnail is too small — fall through to full decode
            decode_and_resize(source_path, max_size)?
        }
    } else {
        // Stage 2: full decode + SIMD resize
        decode_and_resize(source_path, max_size)?
    };

    std::fs::write(&thumb_path, &jpeg_bytes)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;

    Ok(thumb_path)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
async fn get_thumbnail_path(path: String, max_size: Option<u32>) -> Result<String, String> {
    let size = max_size.unwrap_or(300);
    let thumb_path =
        tauri::async_runtime::spawn_blocking(move || ensure_thumbnail(&path, size))
            .await
            .map_err(|e| format!("Thread join error: {}", e))??;

    thumb_path
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Non-UTF8 thumbnail path".to_string())
}

/// Move one or more files to the OS Recycle Bin / Trash.
/// Paths that don't exist are silently ignored (e.g. no paired RAW file).
#[tauri::command]
async fn trash_files(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut errors: Vec<String> = Vec::new();
        for path in &paths {
            let p = std::path::Path::new(path);
            if !p.exists() {
                continue; // paired RAW may not exist — skip silently
            }
            if let Err(e) = trash::delete(p) {
                errors.push(format!("{}: {}", path, e));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    })
    .await
    .map_err(|e| format!("Thread join error: {}", e))?
}

#[tauri::command]
async fn clear_thumbnail_cache() -> Result<(), String> {
    let dir = thumb_dir().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                std::fs::remove_file(entry.path()).ok();
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Thread join error: {}", e))?
}

#[tauri::command]
async fn get_image_metadata(path: String) -> Result<ImageMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut meta = ImageMetadata::default();
        let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(&file);
        
        if let Ok(exif) = exif::Reader::new().read_from_container(&mut reader) {
            if let Some(field) = exif.get_field(exif::Tag::FNumber, exif::In::PRIMARY) {
                meta.f_number = Some(field.display_value().with_unit(&exif).to_string());
            }
            if let Some(field) = exif.get_field(exif::Tag::ExposureTime, exif::In::PRIMARY) {
                meta.exposure_time = Some(field.display_value().with_unit(&exif).to_string());
            }
            if let Some(field) = exif.get_field(exif::Tag::PhotographicSensitivity, exif::In::PRIMARY) {
                meta.iso = Some(field.display_value().with_unit(&exif).to_string());
            }
            if let Some(field) = exif.get_field(exif::Tag::FocalLength, exif::In::PRIMARY) {
                meta.focal_length = Some(field.display_value().with_unit(&exif).to_string());
            }
            if let Some(field) = exif.get_field(exif::Tag::Model, exif::In::PRIMARY) {
                meta.camera_model = Some(field.display_value().to_string().replace("\"", "").trim().to_string());
            }
            if let Some(field) = exif.get_field(exif::Tag::Make, exif::In::PRIMARY) {
                let s = field.display_value().to_string().replace("\"", "").trim().to_string();
                // Special case for common makers to keep them uppercase or properly capitalized
                let s = match s.to_uppercase().as_str() {
                    "FUJIFILM" => "Fujifilm".to_string(),
                    "NIKON" => "Nikon".to_string(),
                    "CANON" => "Canon".to_string(),
                    "SONY" => "Sony".to_string(),
                    "APPLE" => "Apple".to_string(),
                    _ => {
                        let mut c = s.chars();
                        match c.next() {
                            None => String::new(),
                            Some(f) => f.to_uppercase().collect::<String>() + c.as_str().to_lowercase().as_str(),
                        }
                    }
                };
                meta.camera_maker = Some(s);
            }
            if let Some(field) = exif.get_field(exif::Tag::LensModel, exif::In::PRIMARY) {
                let s = field.display_value().to_string().replace("\"", "");
                let s = s.trim_end_matches(&[',', ' '][..]).to_string();
                meta.lens_model = Some(s);
            }
            if let Some(field) = exif.get_field(exif::Tag::ExposureBiasValue, exif::In::PRIMARY) {
                meta.exposure_bias = Some(field.display_value().with_unit(&exif).to_string());
            }
            if let Some(field) = exif.get_field(exif::Tag::ExposureProgram, exif::In::PRIMARY) {
                let s = field.display_value().with_unit(&exif).to_string();
                let mut c = s.chars();
                let s = match c.next() {
                    None => String::new(),
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                };
                meta.exposure_program = Some(s);
            }
            if let Some(field) = exif.get_field(exif::Tag::MeteringMode, exif::In::PRIMARY) {
                let s = field.display_value().with_unit(&exif).to_string();
                let mut c = s.chars();
                let s = match c.next() {
                    None => String::new(),
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                };
                meta.metering_mode = Some(s);
            }
            if let Some(field) = exif.get_field(exif::Tag::Flash, exif::In::PRIMARY) {
                let s = field.display_value().with_unit(&exif).to_string();
                let s = s.split(',').next().unwrap_or(&s).to_string();
                let mut c = s.chars();
                let s = match c.next() {
                    None => String::new(),
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                };
                meta.flash_mode = Some(s);
            }
            if let Some(field) = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
                meta.date_taken = Some(field.display_value().to_string().replace("\"", ""));
            }
            let width = exif.get_field(exif::Tag::PixelXDimension, exif::In::PRIMARY).or_else(|| exif.get_field(exif::Tag::ImageWidth, exif::In::PRIMARY));
            let height = exif.get_field(exif::Tag::PixelYDimension, exif::In::PRIMARY).or_else(|| exif.get_field(exif::Tag::ImageLength, exif::In::PRIMARY));
            if let (Some(w), Some(h)) = (width, height) {
                meta.dimensions = Some(format!("{} x {}", w.display_value(), h.display_value()));
            }
            if let Some(field) = exif.get_field(exif::Tag::Software, exif::In::PRIMARY) {
                meta.software = Some(field.display_value().to_string().replace("\"", "").trim().to_string());
            }
            if let Some(field) = exif.get_field(exif::Tag::WhiteBalance, exif::In::PRIMARY) {
                meta.white_balance = Some(field.display_value().with_unit(&exif).to_string());
            }
            if let Some(field) = exif.get_field(exif::Tag::ExposureMode, exif::In::PRIMARY) {
                meta.exposure_mode = Some(field.display_value().with_unit(&exif).to_string());
            }
        }
        Ok(meta)
    }).await.map_err(|e| e.to_string())?
}

// ── XMP Rating helpers ───────────────────────────────────────────────────────

const XMP_NS_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const JPEG_APP1: u8 = 0xE1;

/// Build a minimal, self-contained XMP packet string.
fn build_xmp_packet(rating: u8) -> String {
    format!(
        r#"<?xpacket begin="\xEF\xBB\xBF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:Rating>{rating}</xmp:Rating>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#
    )
}

/// Update or insert `xmp:Rating` inside an existing XMP packet string.
fn patch_xmp_rating(xmp: &str, rating: u8) -> String {
    let new_tag = format!("<xmp:Rating>{rating}</xmp:Rating>");
    // Replace existing tag
    if let Some(s) = xmp.find("<xmp:Rating>") {
        if let Some(rel_e) = xmp[s..].find("</xmp:Rating>") {
            let e = s + rel_e + "</xmp:Rating>".len();
            return format!("{}{}{}", &xmp[..s], new_tag, &xmp[e..]);
        }
    }
    // Insert before closing </rdf:Description> if namespace already present
    if xmp.contains("xmlns:xmp") {
        if let Some(pos) = xmp.rfind("</rdf:Description>") {
            return format!("{}      {}\n    {}", &xmp[..pos], new_tag, &xmp[pos..]);
        }
    }
    // Fallback: fresh packet
    build_xmp_packet(rating)
}

/// Extract the numeric rating from an XMP packet string.
fn read_xmp_rating(xmp: &str) -> Option<u8> {
    let s = xmp.find("<xmp:Rating>")? + "<xmp:Rating>".len();
    let e = xmp[s..].find("</xmp:Rating>")?;
    xmp[s..s + e].trim().parse().ok()
}

// ── JPEG (embedded XMP) — manual byte-level implementation ──────────────────
// JPEG structure: SOI (FF D8) followed by segments FF <marker> <len_hi> <len_lo> <data>.
// XMP lives in an APP1 (FF E1) segment whose data starts with the 29-byte namespace header.

/// Scan `data` for the XMP APP1 segment.
/// Returns `(seg_start, seg_end)` — byte offsets into `data`.
fn jpeg_find_xmp(data: &[u8]) -> Option<(usize, usize)> {
    if data.len() < 2 || data[0] != 0xFF || data[1] != 0xD8 { return None; }
    let mut pos = 2;
    while pos + 3 < data.len() {
        if data[pos] != 0xFF { return None; }
        let marker = data[pos + 1];
        // Markers with no payload
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) {
            pos += 2;
            continue;
        }
        let seg_len = u16::from_be_bytes([data[pos + 2], data[pos + 3]]) as usize;
        let seg_end = pos + 2 + seg_len;
        if seg_end > data.len() { return None; }
        if marker == 0xE1 {
            let payload = &data[pos + 4..seg_end];
            if payload.len() >= XMP_NS_HEADER.len() && payload.starts_with(XMP_NS_HEADER) {
                return Some((pos, seg_end));
            }
        }
        pos = seg_end;
    }
    None
}

/// Build a raw APP1 XMP segment (marker + big-endian length + header + packet).
fn jpeg_build_xmp_seg(packet: &str) -> Vec<u8> {
    let payload_len = XMP_NS_HEADER.len() + packet.len();
    let seg_len = (payload_len + 2) as u16; // +2 for the length field itself
    let mut seg = vec![0xFF, JPEG_APP1];
    seg.extend_from_slice(&seg_len.to_be_bytes());
    seg.extend_from_slice(XMP_NS_HEADER);
    seg.extend_from_slice(packet.as_bytes());
    seg
}

fn jpeg_set_rating(path: &str, rating: u8) -> Result<(), String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    if data.len() < 2 || data[0] != 0xFF || data[1] != 0xD8 {
        return Err("Not a valid JPEG".into());
    }

    // Read existing XMP packet (if any)
    let existing_xmp = jpeg_find_xmp(&data).and_then(|(s, e)| {
        let payload = &data[s + 4..e];
        String::from_utf8(payload[XMP_NS_HEADER.len()..].to_vec()).ok()
    });
    let packet = match existing_xmp {
        Some(x) => patch_xmp_rating(&x, rating),
        None     => build_xmp_packet(rating),
    };
    let new_seg = jpeg_build_xmp_seg(&packet);

    // Assemble output: SOI + (pre-XMP bytes) + new_seg + (post-XMP bytes)
    let mut out: Vec<u8> = Vec::with_capacity(data.len() + new_seg.len());
    out.extend_from_slice(&data[..2]); // SOI
    match jpeg_find_xmp(&data) {
        Some((xs, xe)) => {
            out.extend_from_slice(&data[2..xs]);
            out.extend_from_slice(&new_seg);
            out.extend_from_slice(&data[xe..]);
        }
        None => {
            // Insert after first APP1 (EXIF) if present, else right after SOI
            let insert = if data.len() > 5 && data[2] == 0xFF && data[3] == 0xE1 {
                let exif_len = u16::from_be_bytes([data[4], data[5]]) as usize;
                let exif_end = 2 + 2 + exif_len;
                if exif_end <= data.len() { exif_end } else { 2 }
            } else { 2 };
            out.extend_from_slice(&data[2..insert]);
            out.extend_from_slice(&new_seg);
            out.extend_from_slice(&data[insert..]);
        }
    }
    std::fs::write(path, out).map_err(|e| e.to_string())
}

fn jpeg_get_rating(path: &str) -> Option<u8> {
    let data = std::fs::read(path).ok()?;
    let (s, e) = jpeg_find_xmp(&data)?;
    let payload = &data[s + 4..e];
    let xmp = std::str::from_utf8(&payload[XMP_NS_HEADER.len()..]).ok()?;
    read_xmp_rating(xmp)
}

// ── RAW (XMP sidecar) ────────────────────────────────────────────────────────

fn sidecar_path(raw_path: &str) -> std::path::PathBuf {
    std::path::Path::new(raw_path).with_extension("xmp")
}

fn raw_set_rating(raw_path: &str, rating: u8) -> Result<(), String> {
    let sidecar = sidecar_path(raw_path);
    let packet = if sidecar.exists() {
        let existing = std::fs::read_to_string(&sidecar).map_err(|e| e.to_string())?;
        patch_xmp_rating(&existing, rating)
    } else {
        build_xmp_packet(rating)
    };
    std::fs::write(&sidecar, packet).map_err(|e| e.to_string())
}

fn raw_get_rating(raw_path: &str) -> Option<u8> {
    let xmp = std::fs::read_to_string(sidecar_path(raw_path)).ok()?;
    read_xmp_rating(&xmp)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
async fn set_rating(path: String, rating: u8) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let low = path.to_lowercase();
        if low.ends_with(".jpg") || low.ends_with(".jpeg") || low.ends_with(".png") {
            jpeg_set_rating(&path, rating)
        } else {
            raw_set_rating(&path, rating)
        }
    })
    .await
    .map_err(|e| format!("Thread join error: {}", e))?
}

#[tauri::command]
async fn get_rating(path: String) -> Result<Option<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let low = path.to_lowercase();
        let r = if low.ends_with(".jpg") || low.ends_with(".jpeg") || low.ends_with(".png") {
            jpeg_get_rating(&path)
        } else {
            raw_get_rating(&path)
        };
        Ok::<_, String>(r)
    })
    .await
    .map_err(|e| format!("Thread join error: {}", e))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let cache_dir = app
                .path()
                .app_cache_dir()
                .expect("failed to resolve app cache dir")
                .join("thumbs");
            std::fs::create_dir_all(&cache_dir)
                .expect("failed to create thumbnail cache directory");
            THUMB_DIR.set(cache_dir).ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_thumbnail_path, clear_thumbnail_cache, get_image_metadata, trash_files, set_rating, get_rating])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
