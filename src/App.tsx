import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { FolderPlus, Filter, Grid, List, PanelLeftClose, PanelLeftOpen, PanelBottomClose, PanelBottomOpen, PanelBottom, PanelLeft, Image as ImageIcon, FileImage, Layers, Columns2, Rows2, Info, Star, Move, Trash2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir, DirEntry } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import "./App.css";

type ImageFile = DirEntry & { fullPath: string };

type ImageMetadata = {
  f_number?: string;
  exposure_time?: string;
  iso?: string;
  focal_length?: string;
  camera_model?: string;
  lens_model?: string;
  dimensions?: string;
  camera_maker?: string;
  exposure_bias?: string;
  exposure_program?: string;
  metering_mode?: string;
  flash_mode?: string;
  date_taken?: string;
  white_balance?: string;
  software?: string;
  exposure_mode?: string;
};

// ── Concurrency limiter ───────────────────────────────────────────────────────
const MAX_THUMB_CONCURRENT = 4;
let _thumbActive = 0;
const _thumbQueue: Array<() => void> = [];

function acquireThumbSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (_thumbActive < MAX_THUMB_CONCURRENT) {
        _thumbActive++;
        resolve(() => {
          _thumbActive--;
          if (_thumbQueue.length > 0) _thumbQueue.shift()!();
        });
      } else {
        _thumbQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

// --- Lazy Thumbnail Component ---
function Thumbnail({ file }: { file: ImageFile }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadedRef.current) {
          loadedRef.current = true;
          observer.disconnect();
          setLoading(true);

          acquireThumbSlot().then((release) => {
            invoke<string>("get_thumbnail_path", { path: file.fullPath, maxSize: 240 })
              .then((thumbPath) => setSrc(convertFileSrc(thumbPath)))
              .catch((e) => {
                console.error("Thumbnail error for", file.fullPath, e);
                setError(true);
              })
              .finally(() => {
                release();
                setLoading(false);
              });
          });
        }
      },
      { rootMargin: "0px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [file.fullPath]);

  return (
    <div ref={ref} className="thumbnail-inner">
      {src ? (
        <img src={src} alt={file.name} className="thumbnail-img" loading="lazy" decoding="async" />
      ) : error ? (
        <div className="thumbnail-raw-placeholder">
          <FileImage size={24} style={{ color: "var(--text-secondary)" }} />
          <span style={{ fontSize: "10px", marginTop: "4px", color: "var(--text-secondary)" }}>Error</span>
        </div>
      ) : loading ? (
        <div className="thumbnail-loading" />
      ) : (
        <div className="thumbnail-loading thumbnail-loading--idle" />
      )}
    </div>
  );
}

const RAW_EXT = /\.(raf|cr2|nef|arw)$/i;
const JPEG_EXT = /\.(jpg|jpeg|png)$/i;

function ImageView({ file, placeholder, comparisonLayout, zoom, pan, onZoomPan, onPanDelta, showMetadata, metadata, otherMetadata, hoveredMetaKey, onMetaHover, onDelete, isDeleting, onStar, isStarred }: { file: ImageFile | null; placeholder: string; comparisonLayout: 'sidebyside' | 'stacked'; zoom: number; pan: { x: number, y: number }; onZoomPan: (zoom: number, pan: { x: number, y: number }) => void; onPanDelta: (dx: number, dy: number) => void; showMetadata: boolean; metadata: ImageMetadata | null; otherMetadata: ImageMetadata | null; hoveredMetaKey: string | null; onMetaHover: (key: string | null) => void; onDelete?: () => void; isDeleting?: boolean; onStar?: () => void; isStarred?: boolean; }) {
  const [src, setSrc] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const lastMousePos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    let active = true;
    if (!file) {
      setSrc(null);
      return;
    }
    const isRaw = RAW_EXT.test(file.name ?? "");
    if (isRaw) {
      invoke<string>("get_thumbnail_path", { path: file.fullPath, maxSize: 1920 })
        .then((p) => {
          if (active) setSrc(convertFileSrc(p));
        })
        .catch((e) => {
          console.error("Failed to load raw image", e);
          if (active) setSrc(null);
        });
    } else {
      setSrc(convertFileSrc(file.fullPath));
    }
    return () => { active = false; };
  }, [file]);

  useEffect(() => {
    if (!isDragging) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - lastMousePos.current.x;
      const dy = e.clientY - lastMousePos.current.y;
      lastMousePos.current = { x: e.clientX, y: e.clientY };
      onPanDelta(dx, dy);
    };

    const handleWindowMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [isDragging, onPanDelta]);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (zoom <= 100) return;
    if (e.button !== 0) return; // Only left click
    e.preventDefault();
    setIsDragging(true);
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const step = zoom >= 100 ? 25 : 10;
    let nextZoom = zoom;
    if (e.deltaY < 0) {
      nextZoom = zoom + step;
    } else if (e.deltaY > 0) {
      nextZoom = zoom - step;
    }
    nextZoom = Math.min(Math.max(100, nextZoom), 1000);

    if (nextZoom !== zoom) {
      const containerRect = e.currentTarget.getBoundingClientRect();
      const cx = containerRect.left + containerRect.width / 2 + pan.x;
      const cy = containerRect.top + containerRect.height / 2 + pan.y;

      const vx = e.clientX - cx;
      const vy = e.clientY - cy;

      const zRatio = nextZoom / zoom;

      const newPanX = pan.x + vx * (1 - zRatio);
      const newPanY = pan.y + vy * (1 - zRatio);

      onZoomPan(nextZoom, nextZoom === 100 ? { x: 0, y: 0 } : { x: newPanX, y: newPanY });
    }
  };

  const getMetaChipClass = (key: keyof ImageMetadata, value: string | undefined) => {
    if (hoveredMetaKey === key) return "meta-chip meta-chip-hover";
    if (key === 'date_taken') return "meta-chip";
    if (otherMetadata) {
      return otherMetadata[key] === value ? "meta-chip meta-chip-match" : "meta-chip meta-chip-diff";
    }
    return "meta-chip";
  };

  if (!file) {
    return (
      <div className="comparison-pane">
        <ImageIcon className="empty-state-icon" strokeWidth={1} />
        <p className="empty-state-desc">{placeholder}</p>
      </div>
    );
  }

  return (
    <div
      className="comparison-pane"
      style={{
        padding: 0,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: comparisonLayout === 'sidebyside' ? 'column' : 'row'
      }}
    >
      <div className={`file-name-badge-top ${comparisonLayout === 'stacked' ? 'right-side' : ''}`} style={{ zIndex: 10, display: 'flex', flexDirection: 'column', gap: '6px', alignItems: comparisonLayout === 'stacked' ? 'flex-end' : 'flex-start', maxWidth: comparisonLayout === 'stacked' ? '400px' : '80%' }}>
        <span style={{ fontWeight: 600 }}>{file.name}</span>
        {showMetadata && metadata && (
          <div className="metadata-chips" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: comparisonLayout === 'stacked' ? 'flex-end' : 'flex-start' }}>
            {metadata.date_taken && <span className={getMetaChipClass('date_taken', metadata.date_taken)} onMouseEnter={() => onMetaHover('date_taken')} onMouseLeave={() => onMetaHover(null)} title="Date taken">{metadata.date_taken}</span>}
            {metadata.dimensions && <span className={getMetaChipClass('dimensions', metadata.dimensions)} onMouseEnter={() => onMetaHover('dimensions')} onMouseLeave={() => onMetaHover(null)} title="Dimensions">{metadata.dimensions}</span>}
            {metadata.camera_maker && <span className={getMetaChipClass('camera_maker', metadata.camera_maker)} onMouseEnter={() => onMetaHover('camera_maker')} onMouseLeave={() => onMetaHover(null)} title="Camera maker">{metadata.camera_maker}</span>}
            {metadata.camera_model && <span className={getMetaChipClass('camera_model', metadata.camera_model)} onMouseEnter={() => onMetaHover('camera_model')} onMouseLeave={() => onMetaHover(null)} title="Camera model">{metadata.camera_model}</span>}
            {metadata.lens_model && <span className={getMetaChipClass('lens_model', metadata.lens_model)} onMouseEnter={() => onMetaHover('lens_model')} onMouseLeave={() => onMetaHover(null)} title="Lens model">{metadata.lens_model}</span>}
            {metadata.f_number && <span className={getMetaChipClass('f_number', metadata.f_number)} onMouseEnter={() => onMetaHover('f_number')} onMouseLeave={() => onMetaHover(null)} title="F-stop">{metadata.f_number}</span>}
            {metadata.exposure_time && <span className={getMetaChipClass('exposure_time', metadata.exposure_time)} onMouseEnter={() => onMetaHover('exposure_time')} onMouseLeave={() => onMetaHover(null)} title="Exposure time">{metadata.exposure_time}</span>}
            {metadata.iso && <span className={getMetaChipClass('iso', metadata.iso)} onMouseEnter={() => onMetaHover('iso')} onMouseLeave={() => onMetaHover(null)} title="ISO speed">ISO {metadata.iso}</span>}
            {metadata.focal_length && <span className={getMetaChipClass('focal_length', metadata.focal_length)} onMouseEnter={() => onMetaHover('focal_length')} onMouseLeave={() => onMetaHover(null)} title="Focal length">{metadata.focal_length}</span>}
            {metadata.exposure_bias && <span className={getMetaChipClass('exposure_bias', metadata.exposure_bias)} onMouseEnter={() => onMetaHover('exposure_bias')} onMouseLeave={() => onMetaHover(null)} title="Exposure bias">{metadata.exposure_bias}</span>}
            {metadata.exposure_program && <span className={getMetaChipClass('exposure_program', metadata.exposure_program)} onMouseEnter={() => onMetaHover('exposure_program')} onMouseLeave={() => onMetaHover(null)} title="Exposure program">{metadata.exposure_program}</span>}
            {metadata.metering_mode && <span className={getMetaChipClass('metering_mode', metadata.metering_mode)} onMouseEnter={() => onMetaHover('metering_mode')} onMouseLeave={() => onMetaHover(null)} title="Metering mode">{metadata.metering_mode}</span>}
            {metadata.flash_mode && <span className={getMetaChipClass('flash_mode', metadata.flash_mode)} onMouseEnter={() => onMetaHover('flash_mode')} onMouseLeave={() => onMetaHover(null)} title="Flash mode">{metadata.flash_mode}</span>}
            {metadata.white_balance && <span className={getMetaChipClass('white_balance', metadata.white_balance)} onMouseEnter={() => onMetaHover('white_balance')} onMouseLeave={() => onMetaHover(null)} title="White balance">{metadata.white_balance}</span>}
            {metadata.exposure_mode && <span className={getMetaChipClass('exposure_mode', metadata.exposure_mode)} onMouseEnter={() => onMetaHover('exposure_mode')} onMouseLeave={() => onMetaHover(null)} title="Exposure mode">{metadata.exposure_mode}</span>}
            {metadata.software && <span className={getMetaChipClass('software', metadata.software)} onMouseEnter={() => onMetaHover('software')} onMouseLeave={() => onMetaHover(null)} title="Software / Firmware">{metadata.software}</span>}
          </div>
        )}
      </div>

      {zoom > 100 && (
        <div className="zoom-indicator">
          {zoom}%
        </div>
      )}

      {comparisonLayout === 'stacked' && (
        <>
          <div className="action-zones stacked">
            <button
              className={`zone-btn zone-star ${isStarred ? 'zone-star--active' : ''}`}
              title={isStarred ? 'Starred (5 stars)' : 'Star Image (5 stars)'}
              onClick={onStar}
            >
              <Star size={32} className="zone-icon" />
            </button>
            <button className="zone-btn zone-move" title="Move Image">
              <Move size={32} className="zone-icon" />
            </button>
            <button
              className={`zone-btn zone-delete ${isDeleting ? 'zone-delete--busy' : ''}`}
              title="Send to Recycle Bin"
              onClick={onDelete}
              disabled={isDeleting}
            >
              <Trash2 size={32} className="zone-icon" />
            </button>
          </div>
          <div
            className="image-container flex-center"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onDoubleClick={() => onZoomPan(100, { x: 0, y: 0 })}
            style={{ cursor: zoom > 100 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
          >
            {src ? (
              <img src={src} alt={file.name} draggable={false} className="contained-image stacked-mode" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`, transition: isDragging ? 'none' : 'transform 0.1s ease-out' }} />
            ) : (
              <div className="thumbnail-loading" style={{ width: "100%", height: "100%" }} />
            )}
          </div>
          <div className="layout-spacer right-spacer" />
        </>
      )}

      {comparisonLayout === 'sidebyside' && (
        <>
          <div className="layout-spacer top-spacer" />
          <div
            className="image-container flex-center"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onDoubleClick={() => onZoomPan(100, { x: 0, y: 0 })}
            style={{ cursor: zoom > 100 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
          >
            {src ? (
              <img src={src} alt={file.name} draggable={false} className="contained-image sidebyside-mode" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`, transition: isDragging ? 'none' : 'transform 0.1s ease-out' }} />
            ) : (
              <div className="thumbnail-loading" style={{ width: "100%", height: "100%" }} />
            )}
          </div>
          <div className="action-zones sidebyside">
            <button
              className={`zone-btn zone-star ${isStarred ? 'zone-star--active' : ''}`}
              title={isStarred ? 'Starred (5 stars)' : 'Star Image (5 stars)'}
              onClick={onStar}
            >
              <Star size={32} className="zone-icon" />
            </button>
            <button className="zone-btn zone-move" title="Move Image">
              <Move size={32} className="zone-icon" />
            </button>
            <button
              className={`zone-btn zone-delete ${isDeleting ? 'zone-delete--busy' : ''}`}
              title="Send to Recycle Bin"
              onClick={onDelete}
              disabled={isDeleting}
            >
              <Trash2 size={32} className="zone-icon" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function App() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarLayout, setSidebarLayout] = useState<'left' | 'bottom'>('left');
  const [sidebarWidth, setSidebarWidth] = useState(360);
  const [sidebarHeight, setSidebarHeight] = useState(250);
  const [isResizing, setIsResizing] = useState(false);
  const [files, setFiles] = useState<ImageFile[]>([]);
  const [currentFolderPath, setCurrentFolderPath] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [comparisonLayout, setComparisonLayout] = useState<'sidebyside' | 'stacked'>('sidebyside');
  const [selectedImage1, setSelectedImage1] = useState<ImageFile | null>(null);
  const [selectedImage2, setSelectedImage2] = useState<ImageFile | null>(null);
  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [metadata1, setMetadata1] = useState<ImageMetadata | null>(null);
  const [metadata2, setMetadata2] = useState<ImageMetadata | null>(null);
  const [showMetadata, setShowMetadata] = useState(false);
  const [hoveredMetaKey, setHoveredMetaKey] = useState<string | null>(null);
  const [isDeleting1, setIsDeleting1] = useState(false);
  const [isDeleting2, setIsDeleting2] = useState(false);
  // fullPath -> rating (0-5); 5 = starred
  const [ratings, setRatings] = useState<Record<string, number>>({});

  useEffect(() => {
    if (selectedImage1) {
      invoke<ImageMetadata>("get_image_metadata", { path: selectedImage1.fullPath }).then(setMetadata1).catch(() => setMetadata1(null));
    } else setMetadata1(null);
  }, [selectedImage1]);

  useEffect(() => {
    if (selectedImage2) {
      invoke<ImageMetadata>("get_image_metadata", { path: selectedImage2.fullPath }).then(setMetadata2).catch(() => setMetadata2(null));
    } else setMetadata2(null);
  }, [selectedImage2]);

  const handleZoomPan = useCallback((newZoom: number, newPan: { x: number, y: number }) => {
    setZoom(newZoom);
    setPan(newPan);
  }, []);

  const handlePanDelta = useCallback((dx: number, dy: number) => {
    setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
  }, []);

  const handleImageClick = useCallback((file: ImageFile) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      setSelectedImage1(file);
      setZoom(100);
      setPan({ x: 0, y: 0 });
    }, 200);
  }, []);

  const handleImageDoubleClick = useCallback((file: ImageFile) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    setSelectedImage2(file);
    setZoom(100);
    setPan({ x: 0, y: 0 });
  }, []);

  // Stars the JPEG (embedded XMP) and its paired RAW (sidecar) with rating=5
  const makeStarHandler = useCallback(
    (file: ImageFile, currentlyStarred: boolean) => async () => {
      const newRating = currentlyStarred ? 0 : 5;
      const pathsToStar: string[] = [file.fullPath];

      // Find paired file in either direction
      if (JPEG_EXT.test(file.name ?? '')) {
        const base = (file.name ?? '').replace(JPEG_EXT, '').toLowerCase();
        const raw = files.find(f => RAW_EXT.test(f.name ?? '') && (f.name ?? '').replace(RAW_EXT, '').toLowerCase() === base);
        if (raw) pathsToStar.push(raw.fullPath);
      } else if (RAW_EXT.test(file.name ?? '')) {
        const base = (file.name ?? '').replace(RAW_EXT, '').toLowerCase();
        const jpeg = files.find(f => JPEG_EXT.test(f.name ?? '') && (f.name ?? '').replace(JPEG_EXT, '').toLowerCase() === base);
        if (jpeg) pathsToStar.push(jpeg.fullPath);
      }

      try {
        await Promise.all(pathsToStar.map(p => invoke('set_rating', { path: p, rating: newRating })));
        setRatings(prev => {
          const next = { ...prev };
          pathsToStar.forEach(p => { next[p] = newRating; }); // UI state
          return next;
        });
      } catch (err) {
        console.error('Failed to set rating:', err);
        alert(`Failed to set rating:\n${err}`);
      }
    },
    [files]
  );

  // Trashes the JPEG and its paired RAW (if any), also cleans up state
  const makeDeleteHandler = useCallback(
    (file: ImageFile, setDeleting: (v: boolean) => void) => async () => {
      if (!window.confirm(`Send "${file.name}" to the Recycle Bin?\nIts paired RAW file (if any) will also be trashed.`)) return;

      setDeleting(true);
      try {
        const pathsToTrash: string[] = [file.fullPath];

        // Resolve the paired RAW path from the current files list
        if (JPEG_EXT.test(file.name ?? '')) {
          const baseName = (file.name ?? '').replace(JPEG_EXT, '').toLowerCase();
          const raw = files.find(f =>
            RAW_EXT.test(f.name ?? '') &&
            (f.name ?? '').replace(RAW_EXT, '').toLowerCase() === baseName
          );
          if (raw) pathsToTrash.push(raw.fullPath);
        }

        await invoke('trash_files', { paths: pathsToTrash });

        // Remove trashed files from state
        const trashedSet = new Set(pathsToTrash);
        setFiles(prev => prev.filter(f => !trashedSet.has(f.fullPath)));
        if (selectedImage1 && trashedSet.has(selectedImage1.fullPath)) {
          setSelectedImage1(null);
          setZoom(100); setPan({ x: 0, y: 0 });
        }
        if (selectedImage2 && trashedSet.has(selectedImage2.fullPath)) {
          setSelectedImage2(null);
          setZoom(100); setPan({ x: 0, y: 0 });
        }
      } catch (err) {
        console.error('Failed to trash files:', err);
        alert(`Failed to delete file:\n${err}`);
      } finally {
        setDeleting(false);
      }
    },
    [files, selectedImage1, selectedImage2]
  );

  // Base names of all RAW files in the folder
  const rawBaseNames = useMemo(
    () =>
      new Set(
        files
          .filter((f) => RAW_EXT.test(f.name ?? ""))
          .map((f) => (f.name ?? "").replace(RAW_EXT, "").toLowerCase())
      ),
    [files] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Base names of all JPEG files in the folder
  const jpegBaseNames = useMemo(
    () =>
      new Set(
        files
          .filter((f) => JPEG_EXT.test(f.name ?? ""))
          .map((f) => (f.name ?? "").replace(JPEG_EXT, "").toLowerCase())
      ),
    [files] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Filtered list: hide RAW files that have a matching JPEG
  const gridFiles = useMemo(
    () =>
      files.filter((f) => {
        const name = f.name ?? "";
        if (!RAW_EXT.test(name)) return true; // always show JPEGs / other
        return !jpegBaseNames.has(name.replace(RAW_EXT, "").toLowerCase());
      }),
    [files, jpegBaseNames] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const startResizing = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      if (isSidebarCollapsed) setIsSidebarCollapsed(false);
    },
    [isSidebarCollapsed]
  );

  const stopResizing = useCallback(() => setIsResizing(false), []);

  const resize = useCallback(
    (e: MouseEvent) => {
      if (isResizing) {
        if (sidebarLayout === 'left') {
          const newWidth = e.clientX;
          const minWidth = 300;
          const maxWidth = window.innerWidth / 2;
          if (newWidth >= minWidth && newWidth <= maxWidth) setSidebarWidth(newWidth);
          else if (newWidth < minWidth && newWidth > 100) setSidebarWidth(minWidth);
          else if (newWidth > maxWidth) setSidebarWidth(maxWidth);
        } else {
          const newHeight = window.innerHeight - e.clientY;
          const minHeight = 235;
          const maxHeight = window.innerHeight * 0.8;
          if (newHeight >= minHeight && newHeight <= maxHeight) setSidebarHeight(newHeight);
          else if (newHeight < minHeight && newHeight > 50) setSidebarHeight(minHeight);
          else if (newHeight > maxHeight) setSidebarHeight(maxHeight);
        }
      }
    },
    [isResizing, sidebarLayout]
  );

  useEffect(() => {
    if (isResizing) {
      window.addEventListener("mousemove", resize);
      window.addEventListener("mouseup", stopResizing);
    }
    return () => {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [isResizing, resize, stopResizing]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.code === "Space") {
        e.preventDefault();

        let shifted = false;

        if (selectedImage1) {
          const currentIdx = gridFiles.findIndex(f => f.fullPath === selectedImage1.fullPath);
          const nextFile = gridFiles.slice(currentIdx + 1).find(f => !RAW_EXT.test(f.name ?? ""));
          if (nextFile) {
            setSelectedImage1(nextFile);
            shifted = true;
          }
        }

        if (selectedImage2) {
          const currentIdx = gridFiles.findIndex(f => f.fullPath === selectedImage2.fullPath);
          const nextFile = gridFiles.slice(currentIdx + 1).find(f => !RAW_EXT.test(f.name ?? ""));
          if (nextFile) {
            setSelectedImage2(nextFile);
            shifted = true;
          }
        }

        if (shifted) {
          setZoom(100);
          setPan({ x: 0, y: 0 });
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedImage1, selectedImage2, files, gridFiles, viewMode]);

  const handleOpenFolder = async () => {
    try {
      const selectedPath = await open({ directory: true, multiple: false });

      if (selectedPath && typeof selectedPath === "string") {
        invoke("clear_thumbnail_cache").catch(() => { });
        setCurrentFolderPath(selectedPath);
        setFiles([]);
        setSelectedImage1(null);
        setSelectedImage2(null);
        setZoom(100);
        setPan({ x: 0, y: 0 });

        const entries = await readDir(selectedPath);

        const validExtensions = [".jpg", ".jpeg", ".png"];
        const rawExtensions = [".raf", ".cr2", ".nef", ".arw"];
        const allExtensions = [...validExtensions, ...rawExtensions];

        const filtered = entries.filter((entry) => {
          if (!entry.isFile) return false;
          const lowerName = (entry.name ?? "").toLowerCase();
          return allExtensions.some((ext) => lowerName.endsWith(ext));
        });

        const imageFilesWithPaths: ImageFile[] = await Promise.all(
          filtered.map(async (entry) => {
            const fullPath = await join(selectedPath, entry.name ?? "");
            return { ...entry, fullPath };
          })
        );

        imageFilesWithPaths.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
        setFiles(imageFilesWithPaths);
        setRatings({});

        // Load existing ratings (non-blocking)
        imageFilesWithPaths.forEach(f => {
          invoke<number | null>('get_rating', { path: f.fullPath })
            .then(r => { if (r != null) setRatings(prev => ({ ...prev, [f.fullPath]: r })); })
            .catch(() => { });
        });
      }
    } catch (error) {
      console.error("Failed to open folder:", error);
    }
  };

  const isStarred1 = !!(selectedImage1 && ratings[selectedImage1.fullPath] === 5);
  const isStarred2 = !!(selectedImage2 && ratings[selectedImage2.fullPath] === 5);

  return (
    <div className={`app-container ${sidebarLayout === 'bottom' ? 'sidebar-bottom' : ''}`} style={{ cursor: isResizing ? (sidebarLayout === 'left' ? "col-resize" : "row-resize") : "default" }}>
      {/* Sidebar */}
      <aside
        className={`sidebar ${sidebarLayout} ${isSidebarCollapsed ? "collapsed" : ""} ${!isResizing ? "animating" : ""}`}
        style={{
          width: sidebarLayout === 'left' ? (isSidebarCollapsed ? undefined : sidebarWidth) : '100%',
          height: sidebarLayout === 'bottom' ? (isSidebarCollapsed ? undefined : sidebarHeight) : '100%',
        }}
      >
        <div className="sidebar-header">
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            {!isSidebarCollapsed && (
              <>
                <button className="btn-icon" title="Filter">
                  <Filter size={18} />
                </button>
                <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border-color)", margin: "0 4px" }} />
                <button
                  className="btn-icon"
                  title="Grid View"
                  style={{ color: viewMode === "grid" ? "var(--text-primary)" : "var(--text-secondary)" }}
                  onClick={() => setViewMode("grid")}
                >
                  <Grid size={18} />
                </button>
                <button
                  className="btn-icon"
                  title="List View"
                  style={{ color: viewMode === "list" ? "var(--text-primary)" : "var(--text-secondary)" }}
                  onClick={() => setViewMode("list")}
                >
                  <List size={18} />
                </button>
                <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border-color)", margin: "0 4px" }} />
                <button className="btn-icon btn-open-folder" title="Open Folder" onClick={handleOpenFolder}>
                  <FolderPlus size={16} />
                </button>
                <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border-color)", margin: "0 4px" }} />
              </>
            )}
            <button
              className="btn-icon"
              onClick={() => setSidebarLayout(p => p === 'left' ? 'bottom' : 'left')}
              title={sidebarLayout === 'left' ? "Move Sidebar to Bottom" : "Move Sidebar to Left"}
            >
              {sidebarLayout === 'left' ? <PanelBottom size={18} /> : <PanelLeft size={18} />}
            </button>
            <button
              className="btn-icon"
              onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
              title={isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
            >
              {sidebarLayout === 'left' ? (
                isSidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />
              ) : (
                isSidebarCollapsed ? <PanelBottomOpen size={18} /> : <PanelBottomClose size={18} />
              )}
            </button>
          </div>
        </div>

        <div
          className="sidebar-content sidebar-grid"
          onWheel={(e) => {
            if (sidebarLayout === 'bottom' && e.deltaY !== 0) {
              e.currentTarget.scrollLeft += e.deltaY;
            }
          }}
        >
          {isSidebarCollapsed ? (
            <div style={{ display: "flex", justifyContent: "center", marginTop: "20px" }}>
              <ImageIcon size={20} style={{ color: "var(--border-color)" }} />
            </div>
          ) : (
            <>
              {files.length === 0 ? (
                <div className="thumbnail-grid-empty">
                  <ImageIcon size={32} style={{ color: "var(--border-color)", marginBottom: "8px" }} />
                  <p style={{ fontSize: "12px", color: "var(--text-secondary)", textAlign: "center" }}>
                    No photos to display in grid.
                  </p>
                </div>
              ) : viewMode === "list" ? (
                <div className="file-list">
                  {gridFiles.map((file) => {
                    const pairedWithRaw =
                      JPEG_EXT.test(file.name ?? "") &&
                      rawBaseNames.has((file.name ?? "").replace(JPEG_EXT, "").toLowerCase());
                    return (
                      <div
                        key={file.fullPath}
                        className={`file-list-item ${selectedImage1?.fullPath === file.fullPath && selectedImage2?.fullPath === file.fullPath
                          ? "selected-both"
                          : selectedImage1?.fullPath === file.fullPath
                            ? "selected-1"
                            : selectedImage2?.fullPath === file.fullPath
                              ? "selected-2"
                              : ""
                          }`}
                        onClick={() => handleImageClick(file)}
                        onDoubleClick={() => handleImageDoubleClick(file)}
                      >
                        <FileImage size={16} className="file-icon" />
                        <span className="file-name">{file.name}</span>
                        {pairedWithRaw && <span className="list-raw-tag">+ RAW</span>}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="thumbnail-grid">
                  {gridFiles.map((file) => {
                    const isRaw = RAW_EXT.test(file.name ?? "");
                    const pairedWithRaw =
                      JPEG_EXT.test(file.name ?? "") &&
                      rawBaseNames.has((file.name ?? "").replace(JPEG_EXT, "").toLowerCase());
                    return (
                      <div
                        key={file.fullPath}
                        className="thumbnail-item"
                        title={file.name}
                        onClick={() => handleImageClick(file)}
                        onDoubleClick={() => handleImageDoubleClick(file)}
                        style={{
                          border: (selectedImage1?.fullPath === file.fullPath && selectedImage2?.fullPath === file.fullPath)
                            ? '2px solid #a855f7'
                            : (selectedImage1?.fullPath === file.fullPath)
                              ? '2px solid var(--accent-color)'
                              : (selectedImage2?.fullPath === file.fullPath)
                                ? '2px solid #ef4444'
                                : '2px solid transparent'
                        }}
                      >
                        <div className="thumbnail-item-media">
                          {isRaw ? (
                            <div className="thumbnail-raw-placeholder">
                              <FileImage size={24} style={{ color: "var(--text-secondary)" }} />
                              <span
                                style={{
                                  fontSize: "10px",
                                  marginTop: "4px",
                                  fontWeight: "bold",
                                  color: "var(--text-secondary)",
                                }}
                              >
                                RAW
                              </span>
                            </div>
                          ) : (
                            <Thumbnail file={file} />
                          )}
                          {pairedWithRaw && (
                            <div className="raw-badge" title="A matching RAW file exists">
                              <Layers size={10} />
                              RAW
                            </div>
                          )}
                          {ratings[file.fullPath] === 5 && (
                            <div className="star-badge" title="5 stars">
                              <Star size={9} />
                            </div>
                          )}
                        </div>
                        <div className="thumbnail-name">{file.name}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Drag handle */}
        {!isSidebarCollapsed && (
          <div
            className={`resizer ${isResizing ? "active" : ""}`}
            onMouseDown={startResizing}
          />
        )}
      </aside>

      {/* Main Content Area */}
      <main className="main-area" style={{ pointerEvents: isResizing ? "none" : "auto" }}>
        <header className="topbar">
          <div className="topbar-info">
            {currentFolderPath && (
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                {files.length} images
              </span>
            )}
          </div>
          <div className="topbar-controls">
            <button className="btn-icon" title="Info" onClick={() => setShowMetadata(!showMetadata)} style={{ color: showMetadata ? 'var(--accent-color)' : 'var(--text-secondary)' }}>
              <Info size={18} />
            </button>
            <button
              className="btn-icon"
              title={comparisonLayout === 'sidebyside' ? 'Stack vertically' : 'Place side by side'}
              onClick={() => setComparisonLayout(l => l === 'sidebyside' ? 'stacked' : 'sidebyside')}
            >
              {comparisonLayout === 'sidebyside' ? <Rows2 size={18} /> : <Columns2 size={18} />}
            </button>
          </div>
        </header>

        <div className="content-grid">
          {files.length === 0 ? (
            <div className="empty-state">
              <FolderPlus className="empty-state-icon" strokeWidth={1} />
              <h2 className="empty-state-title">No Photos Loaded</h2>
              <p className="empty-state-desc">
                Open a folder containing your RAW (.raf) and JPEG images to start culling and organizing.
              </p>
              <button className="btn-primary" style={{ marginTop: "8px" }} onClick={handleOpenFolder}>
                Select Folder
              </button>
            </div>
          ) : (
            <div className={`comparison-placeholder ${comparisonLayout === 'stacked' ? 'stacked' : ''}`}>
              <ImageView file={selectedImage1} placeholder="Click an image to view" comparisonLayout={comparisonLayout} zoom={zoom} pan={pan} onZoomPan={handleZoomPan} onPanDelta={handlePanDelta} showMetadata={showMetadata} metadata={metadata1} otherMetadata={metadata2} hoveredMetaKey={hoveredMetaKey} onMetaHover={setHoveredMetaKey} onDelete={selectedImage1 ? makeDeleteHandler(selectedImage1, setIsDeleting1) : undefined} isDeleting={isDeleting1} onStar={selectedImage1 ? makeStarHandler(selectedImage1, isStarred1) : undefined} isStarred={isStarred1} />
              <ImageView file={selectedImage2} placeholder="Double click an image to compare" comparisonLayout={comparisonLayout} zoom={zoom} pan={pan} onZoomPan={handleZoomPan} onPanDelta={handlePanDelta} showMetadata={showMetadata} metadata={metadata2} otherMetadata={metadata1} hoveredMetaKey={hoveredMetaKey} onMetaHover={setHoveredMetaKey} onDelete={selectedImage2 ? makeDeleteHandler(selectedImage2, setIsDeleting2) : undefined} isDeleting={isDeleting2} onStar={selectedImage2 ? makeStarHandler(selectedImage2, isStarred2) : undefined} isStarred={isStarred2} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
