# Better Photo Studio

A high-performance customizable desktop application designed for photographers to easily cull, compare, organize, and edit large collections of RAW and JPG photos. Built with Tauri, Rust, React, and WebGL.

## Overview

Better Photo Studio is a fast, full-featured, non-destructive photo editor. It brings real-time hardware-accelerated adjustments (crop, rotate, exposure, noise reduction, sharpening, defringing, white balance, vibrance, etc.) to RAW-heavy workflows.

## Workflow & Architecture

1. **Core Framework**
   Tauri + React + TypeScript + Vite: Keeps the desktop app lightweight.

2. **Rendering: PixiJS**
   PixiJS provides hardware-accelerated WebGL rendering. Allows to write custom GLSL fragment shaders to handle exposure, contrast, and color grading instantly as sliders move.

3. **RAW Decoding: libraw-rs**
   Provides bindings to the LibRaw C library, guaranteeing accurate color extraction and demosaicing for heavy RAWs.

4. **Image Processing: image + fast_image_resize**
   Once the final edit parameters are choosen, these crates apply the changes to the new full-resolution file during export.

### Data Flow Example

*   **Load:** Rust reads the `.raf` file using `libraw-rs`, demosaics it into an RGB buffer, and uses `fast_image_resize` to scale it down to a medium resolution proxy.
*   **Transfer:** Rust sends this proxy to React via Tauri's custom asset protocol.
*   **Edit:** React loads the proxy into a PixiJS WebGL canvas. As the user drags the exposure slider, a GLSL shader updates the display.
*   **Export and Render:** React sends an IPC message. Rust applies the exact operations to the original 40MP RGB buffer and writes the final JPEG to disk.

## Development

Ensure dependencies for Tauri and Rust are installed.

```bash
npm install
npm run tauri dev
```
