import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { FolderPlus, Filter, Grid, List, PanelLeftClose, PanelLeftOpen, PanelBottomClose, PanelBottomOpen, PanelBottom, PanelLeft, Image as ImageIcon, FileImage, Columns2, Rows2, Info, Star, Move, Trash2, Grid3X3, Crosshair, ExternalLink, Copy, Check, MousePointer2, RotateCw } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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

const MIN_SIDEBAR_WIDTH = 330;
const MIN_SIDEBAR_HEIGHT = 235;

// Concurrency limiter
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

// Lazy Thumbnail Component
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

function ImageView({ file, placeholder, comparisonLayout, zoom, pan, onZoomPan, onPanDelta, showMetadata, metadata, otherMetadata, hoveredMetaKey, onMetaHover, onDelete, isDeleting, onStar, isStarred, onMove, showRuleOfThirds, showCross, onContextMenu }: { file: ImageFile | null; placeholder: string; comparisonLayout: 'sidebyside' | 'stacked'; zoom: number; pan: { x: number, y: number }; onZoomPan: (zoom: number, pan: { x: number, y: number }) => void; onPanDelta: (dx: number, dy: number) => void; showMetadata: boolean; metadata: ImageMetadata | null; otherMetadata: ImageMetadata | null; hoveredMetaKey: string | null; onMetaHover: (key: string | null) => void; onDelete?: () => void; isDeleting?: boolean; onStar?: () => void; isStarred?: boolean; onMove?: () => void; showRuleOfThirds: boolean; showCross: boolean; onContextMenu?: (e: React.MouseEvent, file: ImageFile) => void; }) {
  const [src, setSrc] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const lastMousePos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!file) {
      setSrc(null);
      setAspectRatio(null);
      return;
    }
    const isRaw = RAW_EXT.test(file.name ?? "");
    if (isRaw) {
      // Raw previews are currently not supported
      setSrc(null);
    } else {
      setSrc(convertFileSrc(file.fullPath));
    }
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
            <button className="zone-btn zone-move" title="Move Image" onClick={onMove}>
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
            onContextMenu={(e) => file && onContextMenu?.(e, file)}
            onDoubleClick={() => onZoomPan(100, { x: 0, y: 0 })}
            style={{ cursor: zoom > 100 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
          >
            {src ? (
              <div className="image-transform-wrapper" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`, transition: isDragging ? 'none' : 'transform 0.1s ease-out', aspectRatio: aspectRatio ? `${aspectRatio}` : 'auto' }}>
                <img src={src} alt={file.name} draggable={false} className="contained-image stacked-mode" onLoad={(e) => setAspectRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)} style={{ width: '100%', height: '100%' }} />
                {showRuleOfThirds && <div className="rule-of-thirds-overlay" />}
                {showCross && <div className="cross-overlay" />}
              </div>
            ) : RAW_EXT.test(file.name ?? "") ? (
              <div className="raw-preview-not-supported">
                <FileImage size={48} strokeWidth={1} />
                <p>Raw previews are currently not supported</p>
              </div>
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
            onContextMenu={(e) => file && onContextMenu?.(e, file)}
            onDoubleClick={() => onZoomPan(100, { x: 0, y: 0 })}
            style={{ cursor: zoom > 100 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
          >
            {src ? (
              <div className="image-transform-wrapper" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`, transition: isDragging ? 'none' : 'transform 0.1s ease-out', aspectRatio: aspectRatio ? `${aspectRatio}` : 'auto' }}>
                <img src={src} alt={file.name} draggable={false} className="contained-image sidebyside-mode" onLoad={(e) => setAspectRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)} style={{ width: '100%', height: '100%' }} />
                {showRuleOfThirds && <div className="rule-of-thirds-overlay" />}
                {showCross && <div className="cross-overlay" />}
              </div>
            ) : RAW_EXT.test(file.name ?? "") ? (
              <div className="raw-preview-not-supported">
                <FileImage size={48} strokeWidth={1} />
                <p>Raw previews are currently not supported</p>
              </div>
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
            <button className="zone-btn zone-move" title="Move Image" onClick={onMove}>
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

function ContextMenu({ x, y, file, onClose, onAction, files, ratings, checkedFiles }: {
  x: number;
  y: number;
  file: ImageFile;
  onClose: () => void;
  onAction: (action: string, file: ImageFile | string[]) => void;
  files: ImageFile[];
  ratings: Record<string, number>;
  checkedFiles: Set<string>;
}) {
  const isMulti = checkedFiles.size > 1 && checkedFiles.has(file.fullPath);
  const targetFiles = isMulti ? Array.from(checkedFiles) : [file.fullPath];
  const count = targetFiles.length;

  const isJpg = JPEG_EXT.test(file.name ?? "");
  const isRaw = RAW_EXT.test(file.name ?? "");

  const baseName = (file.name ?? "").replace(isJpg ? JPEG_EXT : RAW_EXT, "").toLowerCase();

  const pairedRaw = isJpg ? files.find(f => RAW_EXT.test(f.name ?? "") && (f.name ?? "").replace(RAW_EXT, "").toLowerCase() === baseName) : null;
  const pairedJpg = isRaw ? files.find(f => JPEG_EXT.test(f.name ?? "") && (f.name ?? "").replace(JPEG_EXT, "").toLowerCase() === baseName) : null;

  const isBundle = !!(pairedRaw || pairedJpg);
  const isStarred = ratings[file.fullPath] === 5;

  return (
    <div
      className="context-menu"
      style={{ left: x, top: y }}
      onMouseLeave={onClose}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="context-menu-item" onClick={() => { onAction('show_in_folder', file); onClose(); }}>
        <ExternalLink size={14} />
        <span className="context-menu-item-label">Show in Folder</span>
      </div>

      <div className="context-menu-item" onClick={() => { onAction('copy', file); onClose(); }}>
        <Copy size={14} />
        <span className="context-menu-item-label">Copy File Path</span>
      </div>

      {isRaw && (
        <>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { onAction('view1', file); onClose(); }}>
            <MousePointer2 size={14} />
            <span className="context-menu-item-label">View in window 1</span>
          </div>
          <div className="context-menu-item" onClick={() => { onAction('view2', file); onClose(); }}>
            <MousePointer2 size={14} />
            <span className="context-menu-item-label">View in window 2</span>
          </div>
        </>
      )}

      <div className="context-menu-separator" />
      
      <div className="context-menu-item" onClick={() => { onAction('star', isMulti ? targetFiles : file); onClose(); }}>
        <Star size={14} fill={isStarred ? "none" : "currentColor"} style={{ color: isStarred ? "inherit" : "#facc15" }} />
        <span className="context-menu-item-label">{isMulti ? `Star/Unstar ${count} items` : (isStarred ? "Unstar" : "Star")}</span>
        {!isMulti && <span className="context-menu-item-shortcut">S</span>}
      </div>

      <div className="context-menu-item" onClick={() => { onAction('move', isMulti ? targetFiles : file); onClose(); }}>
        <Move size={14} />
        <span className="context-menu-item-label">{isMulti ? `Move ${count} items` : "Move"}</span>
        {!isMulti && <span className="context-menu-item-shortcut">M</span>}
      </div>

      <div className="context-menu-item danger" onClick={() => { onAction('delete', isMulti ? targetFiles : file); onClose(); }}>
        <Trash2 size={14} />
        <span className="context-menu-item-label">{isMulti ? `Delete ${count} items` : (isBundle ? "Delete JPG+RAW" : "Delete")}</span>
        {!isMulti && <span className="context-menu-item-shortcut">Del</span>}
      </div>

      {isBundle && !isMulti && (
        <>
          <div className="context-menu-separator" />

          <div className="context-menu-item danger" onClick={() => { onAction('delete_jpg', file); onClose(); }}>
            <Trash2 size={14} />
            <span className="context-menu-item-label">Delete JPG only</span>
          </div>

          <div className="context-menu-item danger" onClick={() => { onAction('delete_raw', file); onClose(); }}>
            <Trash2 size={14} />
            <span className="context-menu-item-label">Delete RAW only</span>
          </div>
        </>
      )}
    </div>
  );
}

function App() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarLayout, setSidebarLayout] = useState<'left' | 'bottom'>('left');
  const [sidebarWidth, setSidebarWidth] = useState(MIN_SIDEBAR_WIDTH);
  const [sidebarHeight, setSidebarHeight] = useState(MIN_SIDEBAR_HEIGHT);
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
  const [showRuleOfThirds, setShowRuleOfThirds] = useState(false);
  const [showCross, setShowCross] = useState(false);
  const [hoveredMetaKey, setHoveredMetaKey] = useState<string | null>(null);
  const [isDeleting1, setIsDeleting1] = useState(false);
  const [isDeleting2, setIsDeleting2] = useState(false);
  // fullPath -> rating (0-5); 5 = starred
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, file: ImageFile } | null>(null);

  const toggleFileCheck = useCallback((fullPath: string) => {
    setCheckedFiles(prev => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, file: ImageFile) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, file });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    const handleWindowClick = () => closeContextMenu();
    window.addEventListener('click', handleWindowClick);
    return () => window.removeEventListener('click', handleWindowClick);
  }, [closeContextMenu]);

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
          pathsToStar.forEach(p => { next[p] = newRating; }); // for UI state
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

  const makeMoveHandler = useCallback(
    (file: ImageFile) => async () => {
      try {
        const destDir = await open({ directory: true, multiple: false });
        if (destDir && typeof destDir === 'string') {
          const fileName = file.name ?? "";

          // Resolve paired file
          const pathsToMove = [file.fullPath];
          const isJpgFile = JPEG_EXT.test(fileName);
          const baseName = fileName.replace(isJpgFile ? JPEG_EXT : RAW_EXT, "").toLowerCase();
          const paired = files.find(f => (isJpgFile ? RAW_EXT : JPEG_EXT).test(f.name ?? "") && (f.name ?? "").replace(isJpgFile ? RAW_EXT : JPEG_EXT, "").toLowerCase() === baseName);

          if (paired) {
            const confirmMove = window.confirm(`Move "${fileName}" and its paired file "${paired.name}" to ${destDir}?`);
            if (!confirmMove) return;
            pathsToMove.push(paired.fullPath);
          }

          await invoke('move_files', { paths: pathsToMove, destDir });

          // Cleanup state
          const movedSet = new Set(pathsToMove);
          setFiles(prev => prev.filter(f => !movedSet.has(f.fullPath)));
          if (selectedImage1 && movedSet.has(selectedImage1.fullPath)) {
            setSelectedImage1(null);
            setZoom(100); setPan({ x: 0, y: 0 });
          }
          if (selectedImage2 && movedSet.has(selectedImage2.fullPath)) {
            setSelectedImage2(null);
            setZoom(100); setPan({ x: 0, y: 0 });
          }
        }
      } catch (err) {
        console.error('Failed to move:', err);
        alert(`Failed to move file:\n${err}`);
      }
    },
    [files, selectedImage1, selectedImage2]
  );

  const handleContextMenuAction = useCallback(async (action: string, target: ImageFile | string[]) => {
    const isBulk = Array.isArray(target);
    const mainFile = isBulk ? null : target as ImageFile;
    const paths = isBulk ? target as string[] : [mainFile!.fullPath];

    switch (action) {
      case 'show_in_folder':
        if (mainFile) {
          try {
            await revealItemInDir(mainFile.fullPath);
          } catch (err) {
            console.error('Failed to show in folder:', err);
          }
        }
        break;
      case 'star':
        if (isBulk) {
          const currentlyStarred = ratings[paths[0]] === 5;
          const newRating = currentlyStarred ? 0 : 5;
          const allPaths = new Set(paths);
          // Auto-include pairs for bulk action
          paths.forEach(p => {
            const f = files.find(file => file.fullPath === p);
            if (f) {
              const base = (f.name ?? '').replace(JPEG_EXT.test(f.name ?? '') ? JPEG_EXT : RAW_EXT, '').toLowerCase();
              const pair = files.find(other => other.fullPath !== p && (other.name ?? '').toLowerCase().startsWith(base));
              if (pair) allPaths.add(pair.fullPath);
            }
          });
          const finalPaths = Array.from(allPaths);
          try {
            await Promise.all(finalPaths.map(p => invoke('set_rating', { path: p, rating: newRating })));
            setRatings(prev => {
              const next = { ...prev };
              finalPaths.forEach(p => { next[p] = newRating; });
              return next;
            });
          } catch (err) {
            alert(`Failed to star files:\n${err}`);
          }
        } else if (mainFile) {
          const currentlyStarred = ratings[mainFile.fullPath] === 5;
          await makeStarHandler(mainFile, currentlyStarred)();
        }
        break;
      case 'delete':
        if (isBulk) {
          if (window.confirm(`Delete ${paths.length} selected items and their pairs?`)) {
            const allPaths = new Set(paths);
            paths.forEach(p => {
              const f = files.find(file => file.fullPath === p);
              if (f) {
                const base = (f.name ?? '').replace(JPEG_EXT.test(f.name ?? '') ? JPEG_EXT : RAW_EXT, '').toLowerCase();
                const pair = files.find(other => other.fullPath !== p && (other.name ?? '').toLowerCase().startsWith(base));
                if (pair) allPaths.add(pair.fullPath);
              }
            });
            const finalPaths = Array.from(allPaths);
            try {
              await invoke('trash_files', { paths: finalPaths });
              const trashedSet = new Set(finalPaths);
              setFiles(prev => prev.filter(f => !trashedSet.has(f.fullPath)));
              if (selectedImage1 && trashedSet.has(selectedImage1.fullPath)) setSelectedImage1(null);
              if (selectedImage2 && trashedSet.has(selectedImage2.fullPath)) setSelectedImage2(null);
              setCheckedFiles(prev => {
                const next = new Set(prev);
                trashedSet.forEach(p => next.delete(p));
                return next;
              });
            } catch (err) {
              alert(`Failed to delete files:\n${err}`);
            }
          }
        } else if (mainFile) {
          await makeDeleteHandler(mainFile, mainFile.fullPath === selectedImage1?.fullPath ? setIsDeleting1 : setIsDeleting2)();
        }
        break;
      case 'move':
        if (isBulk) {
          try {
            const destDir = await open({ directory: true, multiple: false });
            if (destDir && typeof destDir === 'string') {
              const allPaths = new Set(paths);
              paths.forEach(p => {
                const f = files.find(file => file.fullPath === p);
                if (f) {
                  const base = (f.name ?? '').replace(JPEG_EXT.test(f.name ?? '') ? JPEG_EXT : RAW_EXT, '').toLowerCase();
                  const pair = files.find(other => other.fullPath !== p && (other.name ?? '').toLowerCase().startsWith(base));
                  if (pair) allPaths.add(pair.fullPath);
                }
              });
              const finalPaths = Array.from(allPaths);
              if (window.confirm(`Move ${finalPaths.length} items (including pairs) to ${destDir}?`)) {
                await invoke('move_files', { paths: finalPaths, destDir });
                const movedSet = new Set(finalPaths);
                setFiles(prev => prev.filter(f => !movedSet.has(f.fullPath)));
                if (selectedImage1 && movedSet.has(selectedImage1.fullPath)) setSelectedImage1(null);
                if (selectedImage2 && movedSet.has(selectedImage2.fullPath)) setSelectedImage2(null);
                setCheckedFiles(prev => {
                  const next = new Set(prev);
                  movedSet.forEach(p => next.delete(p));
                  return next;
                });
              }
            }
          } catch (err) {
            alert(`Failed to move files:\n${err}`);
          }
        } else if (mainFile) {
          await makeMoveHandler(mainFile)();
        }
        break;
      case 'copy':
        if (mainFile) {
          try {
            await navigator.clipboard.writeText(mainFile.fullPath);
          } catch (err) {
            console.error('Failed to copy path:', err);
          }
        }
        break;
      case 'view1':
        if (mainFile) {
          setSelectedImage1(mainFile);
          setZoom(100);
          setPan({ x: 0, y: 0 });
        }
        break;
      case 'view2':
        if (mainFile) {
          setSelectedImage2(mainFile);
          setZoom(100);
          setPan({ x: 0, y: 0 });
        }
        break;
      case 'delete_jpg':
      case 'delete_raw':
        if (mainFile) {
          const isDeleteJpg = action === 'delete_jpg';
          const isJpg = JPEG_EXT.test(mainFile.name ?? "");
          const base = (mainFile.name ?? "").replace(isJpg ? JPEG_EXT : RAW_EXT, "").toLowerCase();
          const target = files.find(f => (isDeleteJpg ? JPEG_EXT : RAW_EXT).test(f.name ?? "") && (f.name ?? "").replace(isDeleteJpg ? JPEG_EXT : RAW_EXT, "").toLowerCase() === base);

          if (target) {
            if (window.confirm(`Delete associated ${isDeleteJpg ? 'JPG' : 'RAW'} file: "${target.name}"?`)) {
              try {
                await invoke('trash_files', { paths: [target.fullPath] });
                setFiles(prev => prev.filter(f => f.fullPath !== target.fullPath));
                if (selectedImage1?.fullPath === target.fullPath) setSelectedImage1(null);
                if (selectedImage2?.fullPath === target.fullPath) setSelectedImage2(null);
              } catch (err) {
                alert(`Failed to delete file:\n${err}`);
              }
            }
          }
        }
        break;
    }
  }, [files, ratings, selectedImage1, selectedImage2, makeStarHandler, makeDeleteHandler, makeMoveHandler]);

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
  const bundleCount = useMemo(() => {
    let count = 0;
    rawBaseNames.forEach((base) => {
      if (jpegBaseNames.has(base)) count++;
    });
    return count;
  }, [rawBaseNames, jpegBaseNames]);

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
          const maxWidth = window.innerWidth / 2;
          if (newWidth >= MIN_SIDEBAR_WIDTH && newWidth <= maxWidth) setSidebarWidth(newWidth);
          else if (newWidth < MIN_SIDEBAR_WIDTH && newWidth > 100) setSidebarWidth(MIN_SIDEBAR_WIDTH);
          else if (newWidth > maxWidth) setSidebarWidth(maxWidth);
        } else {
          const newHeight = window.innerHeight - e.clientY;
          const maxHeight = window.innerHeight * 0.8;
          if (newHeight >= MIN_SIDEBAR_HEIGHT && newHeight <= maxHeight) setSidebarHeight(newHeight);
          else if (newHeight < MIN_SIDEBAR_HEIGHT && newHeight > 50) setSidebarHeight(MIN_SIDEBAR_HEIGHT);
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

  const loadFolderContents = useCallback(async (path: string) => {
    try {
      invoke("clear_thumbnail_cache").catch(() => { });
      setCurrentFolderPath(path);
      setFiles([]);
      setSelectedImage1(null);
      setSelectedImage2(null);
      setZoom(100);
      setPan({ x: 0, y: 0 });

      const entries = await readDir(path);

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
          const fullPath = await join(path, entry.name ?? "");
          return { ...entry, fullPath };
        })
      );

      imageFilesWithPaths.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
      setFiles(imageFilesWithPaths);
      setRatings({});
      setCheckedFiles(new Set());

      // Load existing ratings (non-blocking)
      imageFilesWithPaths.forEach(f => {
        invoke<number | null>('get_rating', { path: f.fullPath })
          .then(r => { if (r != null) setRatings(prev => ({ ...prev, [f.fullPath]: r })); })
          .catch(() => { });
      });
    } catch (error) {
      console.error("Failed to load folder contents:", error);
    }
  }, []);

  const handleOpenFolder = async () => {
    try {
      const selectedPath = await open({ directory: true, multiple: false });
      if (selectedPath && typeof selectedPath === "string") {
        await loadFolderContents(selectedPath);
      }
    } catch (error) {
      console.error("Failed to open folder:", error);
    }
  };

  const handleRefresh = async () => {
    if (currentFolderPath) {
      await loadFolderContents(currentFolderPath);
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
          <div style={{
            display: "flex",
            flexDirection: (isSidebarCollapsed && sidebarLayout === 'left') ? 'column' : 'row',
            alignItems: "center",
            gap: (isSidebarCollapsed && sidebarLayout === 'left') ? "12px" : "4px",
            padding: (isSidebarCollapsed && sidebarLayout === 'left') ? "12px 0" : "0"
          }}>
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
                <button className="btn-icon btn-open-folder" title="Load Folder" onClick={handleOpenFolder}>
                  <FolderPlus size={16} />
                </button>
                <button
                  className="btn-icon btn-refresh"
                  title="Refresh Folder"
                  onClick={handleRefresh}
                  disabled={!currentFolderPath}
                  style={{ opacity: currentFolderPath ? 1 : 0.5 }}
                >
                  <RotateCw size={16} />
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
          {isSidebarCollapsed ? null : (
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
                        onContextMenu={(e) => handleContextMenu(e, file)}
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
                        onContextMenu={(e) => handleContextMenu(e, file)}
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
                              +RAW
                            </div>
                          )}
                          <div
                            className={`selection-checkbox ${checkedFiles.has(file.fullPath) ? 'checked' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFileCheck(file.fullPath);
                            }}
                          >
                            {checkedFiles.has(file.fullPath) && <Check size={12} strokeWidth={3} />}
                          </div>
                          {ratings[file.fullPath] === 5 && (
                            <div className="star-badge" title="5 stars">
                              <Star size={13} fill="#ffd016ff" />
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
                {files.length} files | {bundleCount} JPG+RAW
              </span>
            )}
          </div>
          <div className="topbar-controls">
            <button className="btn-icon" title="Info" onClick={() => setShowMetadata(!showMetadata)} style={{ color: showMetadata ? 'var(--accent-color)' : 'var(--text-secondary)' }}>
              <Info size={18} />
            </button>
            <button className="btn-icon" title="Rule of Thirds" onClick={() => setShowRuleOfThirds(!showRuleOfThirds)} style={{ color: showRuleOfThirds ? 'var(--accent-color)' : 'var(--text-secondary)' }}>
              <Grid3X3 size={18} />
            </button>
            <button className="btn-icon" title="Cross Overlay" onClick={() => setShowCross(!showCross)} style={{ color: showCross ? 'var(--accent-color)' : 'var(--text-secondary)' }}>
              <Crosshair size={18} />
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
              <ImageView file={selectedImage1} placeholder="Click an image to view it here" comparisonLayout={comparisonLayout} zoom={zoom} pan={pan} onZoomPan={handleZoomPan} onPanDelta={handlePanDelta} showMetadata={showMetadata} metadata={metadata1} otherMetadata={metadata2} hoveredMetaKey={hoveredMetaKey} onMetaHover={setHoveredMetaKey} onDelete={selectedImage1 ? makeDeleteHandler(selectedImage1, setIsDeleting1) : undefined} isDeleting={isDeleting1} onStar={selectedImage1 ? makeStarHandler(selectedImage1, isStarred1) : undefined} isStarred={isStarred1} onMove={selectedImage1 ? makeMoveHandler(selectedImage1) : undefined} showRuleOfThirds={showRuleOfThirds} showCross={showCross} onContextMenu={handleContextMenu} />
              <ImageView file={selectedImage2} placeholder="Double click an image to view it here" comparisonLayout={comparisonLayout} zoom={zoom} pan={pan} onZoomPan={handleZoomPan} onPanDelta={handlePanDelta} showMetadata={showMetadata} metadata={metadata2} otherMetadata={metadata1} hoveredMetaKey={hoveredMetaKey} onMetaHover={setHoveredMetaKey} onDelete={selectedImage2 ? makeDeleteHandler(selectedImage2, setIsDeleting2) : undefined} isDeleting={isDeleting2} onStar={selectedImage2 ? makeStarHandler(selectedImage2, isStarred2) : undefined} isStarred={isStarred2} onMove={selectedImage2 ? makeMoveHandler(selectedImage2) : undefined} showRuleOfThirds={showRuleOfThirds} showCross={showCross} onContextMenu={handleContextMenu} />
            </div>
          )}
        </div>
      </main>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          file={contextMenu.file}
          onClose={closeContextMenu}
          onAction={handleContextMenuAction}
          files={files}
          ratings={ratings}
          checkedFiles={checkedFiles}
        />
      )}
    </div>
  );
}

export default App;
