// Bersales — scanner.js
//
// Camera capture + perspective correction, entirely on-device (getUserMedia
// + canvas). No image is ever sent anywhere — detection, cropping, warping
// and enhancement all happen in a canvas in memory before the result is
// handed to vault.js for encrypted storage.
//
// Corner detection note: autoDetectCorners() below is a dependency-free
// edge-contrast heuristic, NOT a full computer-vision pipeline. A real
// CamScanner-grade detector (Canny edges + contour fitting, e.g. via
// OpenCV.js) would mean shipping an 8MB+ WASM blob in an app whose whole
// pitch is "small, offline, local-only" — a bad trade for a first release.
// Instead this scans inward from each corner of the frame along the
// diagonal looking for the first strong contrast edge, which works well
// when the document has reasonable contrast against the surface under it
// (the common case), and falls back to a fixed inset when it can't find a
// confident edge. Like CamScanner itself, the result is always shown as
// draggable handles — this is a smart starting guess, not a blind crop.

const Scanner = (() => {
  let stream = null;
  let videoEl = null;

  async function startCamera(videoElement) {
    videoEl = videoElement;
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    videoEl.srcObject = stream;
    await videoEl.play();
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  function capturePhoto() {
    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    canvas.getContext('2d').drawImage(videoEl, 0, 0);
    return canvas; // caller decides whether to crop or use as-is
  }

  // --- Perspective correction (4-point transform) ---------------------
  //
  // corners: [{x,y}, {x,y}, {x,y}, {x,y}] in source-image pixel coords,
  // ordered top-left, top-right, bottom-right, bottom-left.
  // Returns a new canvas of size outW x outH with the quad warped to fill it.

  function computeHomography(src, dst) {
    // Solve for the 8 coefficients of a projective transform mapping
    // src[i] -> dst[i] for i in 0..3, using Gaussian elimination on the
    // standard 8x8 system for a planar homography.
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const { x: sx, y: sy } = src[i];
      const { x: dx, y: dy } = dst[i];
      A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]);
      b.push(dx);
      A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]);
      b.push(dy);
    }
    const h = solveLinearSystem(A, b); // [a,b,c,d,e,f,g,h] with i=1 implicit
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function solveLinearSystem(A, b) {
    const n = A.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
      }
      [M[col], M[pivot]] = [M[pivot], M[col]];
      const pivotVal = M[col][col];
      if (Math.abs(pivotVal) < 1e-12) continue; // degenerate; caller should validate corners
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const factor = M[row][col] / pivotVal;
        for (let k = col; k <= n; k++) M[row][k] -= factor * M[col][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  function applyHomographyInverse(H, x, y) {
    // H maps source -> dest. To render dest pixel-by-pixel we need the
    // inverse mapping (dest -> source), so invert the 3x3 matrix H.
    const [a, b, c, d, e, f, g, h, i] = H;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return null;
    const invDet = 1 / det;
    const inv = [
      (e * i - f * h) * invDet, (c * h - b * i) * invDet, (b * f - c * e) * invDet,
      (f * g - d * i) * invDet, (a * i - c * g) * invDet, (c * d - a * f) * invDet,
      (d * h - e * g) * invDet, (b * g - a * h) * invDet, (a * e - b * d) * invDet
    ];
    const w = inv[6] * x + inv[7] * y + inv[8];
    const sx = (inv[0] * x + inv[1] * y + inv[2]) / w;
    const sy = (inv[3] * x + inv[4] * y + inv[5]) / w;
    return { x: sx, y: sy };
  }

  function warpToRectangle(sourceCanvas, corners, outW, outH) {
    const dst = [
      { x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }
    ];
    const H = computeHomography(corners, dst);

    const srcCtx = sourceCanvas.getContext('2d');
    const srcData = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext('2d');
    const outData = outCtx.createImageData(outW, outH);

    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const src = applyHomographyInverse(H, x + 0.5, y + 0.5);
        const outIdx = (y * outW + x) * 4;
        if (!src || src.x < 0 || src.y < 0 || src.x >= sourceCanvas.width - 1 || src.y >= sourceCanvas.height - 1) {
          outData.data[outIdx + 3] = 0; // transparent if out of bounds
          continue;
        }
        // Bilinear sample.
        const x0 = Math.floor(src.x), y0 = Math.floor(src.y);
        const fx = src.x - x0, fy = src.y - y0;
        for (let c = 0; c < 4; c++) {
          const p00 = srcData.data[(y0 * sourceCanvas.width + x0) * 4 + c];
          const p10 = srcData.data[(y0 * sourceCanvas.width + x0 + 1) * 4 + c];
          const p01 = srcData.data[((y0 + 1) * sourceCanvas.width + x0) * 4 + c];
          const p11 = srcData.data[((y0 + 1) * sourceCanvas.width + x0 + 1) * 4 + c];
          const top = p00 * (1 - fx) + p10 * fx;
          const bottom = p01 * (1 - fx) + p11 * fx;
          outData.data[outIdx + c] = top * (1 - fy) + bottom * fy;
        }
      }
    }
    outCtx.putImageData(outData, 0, 0);
    return outCanvas;
  }

  function defaultCorners(width, height) {
    const insetX = width * 0.08;
    const insetY = height * 0.08;
    return [
      { x: insetX, y: insetY },
      { x: width - insetX, y: insetY },
      { x: width - insetX, y: height - insetY },
      { x: insetX, y: height - insetY }
    ];
  }

  // --- Auto corner detection (heuristic, see file header note) ---------

  function cornersAreSane(corners, imgW, imgH) {
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const spanW = Math.max(...xs) - Math.min(...xs);
    const spanH = Math.max(...ys) - Math.min(...ys);
    return spanW > imgW * 0.3 && spanH > imgH * 0.3;
  }

  function autoDetectCorners(sourceCanvas) {
    const fallback = defaultCorners(sourceCanvas.width, sourceCanvas.height);
    try {
      const maxDim = 500;
      const scale = Math.min(1, maxDim / Math.max(sourceCanvas.width, sourceCanvas.height));
      const w = Math.max(10, Math.round(sourceCanvas.width * scale));
      const h = Math.max(10, Math.round(sourceCanvas.height * scale));
      const small = document.createElement('canvas');
      small.width = w; small.height = h;
      const sctx = small.getContext('2d');
      sctx.drawImage(sourceCanvas, 0, 0, w, h);
      const { data } = sctx.getImageData(0, 0, w, h);

      // Grayscale.
      const gray = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      }

      // Simple gradient magnitude (central differences) as an edge map.
      const grad = new Float32Array(w * h);
      let sum = 0, sumSq = 0, count = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const idx = y * w + x;
          const gx = gray[idx + 1] - gray[idx - 1];
          const gy = gray[idx + w] - gray[idx - w];
          const mag = Math.sqrt(gx * gx + gy * gy);
          grad[idx] = mag;
          sum += mag; sumSq += mag * mag; count++;
        }
      }
      const mean = sum / count;
      const variance = Math.max(0, sumSq / count - mean * mean);
      const threshold = mean + Math.sqrt(variance) * 1.2;

      function findCorner(startX, startY, dirX, dirY) {
        const maxSteps = Math.min(w, h) * 0.45;
        for (let step = 2; step < maxSteps; step++) {
          const x = Math.round(startX + dirX * step);
          const y = Math.round(startY + dirY * step);
          if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) break;
          let hit = false;
          for (let oy = -1; oy <= 1 && !hit; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              if (grad[(y + oy) * w + (x + ox)] > threshold) { hit = true; break; }
            }
          }
          if (hit) return { x: x / scale, y: y / scale };
        }
        return null;
      }

      const insetX = w * 0.06, insetY = h * 0.06;
      const detected = [
        findCorner(insetX, insetY, 1, 1),
        findCorner(w - insetX, insetY, -1, 1),
        findCorner(w - insetX, h - insetY, -1, -1),
        findCorner(insetX, h - insetY, 1, -1)
      ].map((c, i) => c || fallback[i]);

      return cornersAreSane(detected, sourceCanvas.width, sourceCanvas.height) ? detected : fallback;
    } catch (e) {
      // Any failure here (unsupported canvas ops, etc.) just falls back to
      // the old fixed inset — the user can still drag corners manually.
      return fallback;
    }
  }

  // --- Auto-enhance (white balance + contrast stretch + shadow lift) ---
  //
  // One deliberate pass, not a filter picker: gray-world white balance
  // corrects indoor color casts, a 1%-clipped contrast stretch uses the
  // full tonal range, and a gentle gamma lift brightens shadows so text
  // stays readable without blowing out highlights. Mutates and returns the
  // same canvas it's given.

  function enhanceCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const n = w * h;
    const stride = 4; // sample every 4th pixel for the stats passes — plenty for a global estimate, much faster

    let sumR = 0, sumG = 0, sumB = 0, sampled = 0;
    for (let i = 0; i < n; i += stride) {
      sumR += data[i * 4]; sumG += data[i * 4 + 1]; sumB += data[i * 4 + 2];
      sampled++;
    }
    const avgR = sumR / sampled || 1, avgG = sumG / sampled || 1, avgB = sumB / sampled || 1;
    const avgGray = (avgR + avgG + avgB) / 3;
    const kr = avgGray / avgR, kg = avgGray / avgG, kb = avgGray / avgB;

    const histR = new Uint32Array(256), histG = new Uint32Array(256), histB = new Uint32Array(256);
    for (let i = 0; i < n; i += stride) {
      const r = Math.min(255, data[i * 4] * kr) | 0;
      const g = Math.min(255, data[i * 4 + 1] * kg) | 0;
      const b = Math.min(255, data[i * 4 + 2] * kb) | 0;
      histR[r]++; histG[g]++; histB[b]++;
    }
    function bounds(hist) {
      const clip = sampled * 0.01;
      let lo = 0, acc = 0;
      while (lo < 255 && acc < clip) { acc += hist[lo]; lo++; }
      let hi = 255; acc = 0;
      while (hi > 0 && acc < clip) { acc += hist[hi]; hi--; }
      if (hi <= lo) return [0, 255];
      return [lo, hi];
    }
    const [rLo, rHi] = bounds(histR);
    const [gLo, gHi] = bounds(histG);
    const [bLo, bHi] = bounds(histB);
    const gamma = 0.85; // < 1 brightens midtones/shadows

    function stretch(v, lo, hi) {
      let t = (v - lo) / ((hi - lo) || 1);
      t = Math.min(1, Math.max(0, t));
      t = Math.pow(t, gamma);
      return t * 255;
    }

    for (let i = 0; i < n; i++) {
      const idx = i * 4;
      data[idx] = stretch(data[idx] * kr, rLo, rHi);
      data[idx + 1] = stretch(data[idx + 1] * kg, gLo, gHi);
      data[idx + 2] = stretch(data[idx + 2] * kb, bLo, bHi);
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  return { startCamera, stopCamera, capturePhoto, warpToRectangle, defaultCorners, autoDetectCorners, enhanceCanvas };
})();
