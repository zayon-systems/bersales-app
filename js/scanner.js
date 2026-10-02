// Bersales — scanner.js
//
// Camera capture + perspective correction, entirely on-device (getUserMedia
// + canvas). No image is ever sent anywhere — detection, cropping, warping
// and enhancement all happen in a canvas in memory before the result is
// handed to vault.js for encrypted storage.
//
// Corner detection note: detectQuadCore() below (see "Document quad
// detection") is a real classical-CV pipeline — Sobel edges, non-max
// suppression, a Hough line transform, then fitting the document's 4 sides
// from the dominant pair of roughly-perpendicular line directions — written
// in plain JS/canvas, not the old single-shot "scan inward from each frame
// corner along a diagonal" heuristic this replaced. Still dependency-free:
// a real CamScanner-grade contour detector usually leans on OpenCV.js, an
// 8MB+ WASM blob that's a bad trade for an offline-first, small-footprint
// app, so this gets most of the way there (validated against synthetic
// rotated-document test images — see git history / PR notes around
// v1.7.0) without that cost. Like CamScanner, the result is always shown
// as draggable handles after capture — a strong starting guess, not a
// blind crop — and is also run continuously (at a smaller, faster working
// resolution — see startLiveDetection()) to show a live tracking outline
// on the camera preview before the user taps Capture.

const Scanner = (() => {
  let stream = null;
  let videoEl = null;
  let liveDetectionTimer = null;
  let liveDetectionBusy = false;

  async function startCamera(videoElement) {
    videoEl = videoElement;
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    applyContinuousFocus();
  }

  function stopCamera() {
    stopLiveDetection();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  // --- Live quad tracking (runs while the camera preview is up, before
  // capture) --------------------------------------------------------------
  //
  // Polls the live video on an interval (not every frame — see the timing
  // note above detectQuadCore) and calls onDetected(corners|null) with
  // whatever was found, in the VIDEO ELEMENT'S NATIVE pixel space
  // (videoWidth/videoHeight) — same convention autoDetectCorners() uses for
  // the canvas it's given, so the caller always scales from native
  // resolution to whatever CSS size the element is actually rendered at
  // (app.js already does this for the post-capture crop handles; the live
  // overlay does the same thing). onDetected is called with null whenever
  // nothing was found that frame, so the caller can hide the overlay rather
  // than leave a stale outline on screen.
  //
  // The busy flag means a slow run (e.g. an underpowered phone, or the
  // first run before the JIT has warmed up) just skips ticks instead of
  // piling up overlapping detection passes — worst case the outline
  // updates less often, it never backs up.
  function startLiveDetection(videoElement, onDetected, intervalMs) {
    stopLiveDetection();
    const interval = intervalMs || 300;
    liveDetectionTimer = setInterval(() => {
      if (liveDetectionBusy) return;
      if (!videoElement.videoWidth || !videoElement.videoHeight) return;
      liveDetectionBusy = true;
      try {
        const corners = detectQuadFromVideoFrame(videoElement);
        onDetected(corners);
      } catch (e) {
        onDetected(null);
      } finally {
        liveDetectionBusy = false;
      }
    }, interval);
  }

  function stopLiveDetection() {
    if (liveDetectionTimer) {
      clearInterval(liveDetectionTimer);
      liveDetectionTimer = null;
    }
  }

  // --- Focus -------------------------------------------------------------
  //
  // Document scanning is a close-up, macro-range shot, and a lot of Android
  // camera stacks hand a fresh getUserMedia track a focus mode/distance
  // tuned for general photography rather than paperwork inches from the
  // lens — which is why "the scanner can't focus" is a real complaint even
  // on phones whose own camera app focuses on documents fine. These are
  // applied via applyConstraints (not requested in the initial
  // getUserMedia() call above) because focus capabilities are only
  // queryable once the track exists, and plenty of devices/browsers expose
  // none of this at all — both functions are wrapped so that's a silent
  // no-op, never a hard failure.

  async function applyContinuousFocus() {
    try {
      const track = stream && stream.getVideoTracks()[0];
      if (!track || !track.getCapabilities) return;
      const caps = track.getCapabilities();
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch (e) {
      // Not supported here — camera keeps whatever default focus it started with.
    }
  }

  // Tap-to-focus: re-triggers focus at a point in the frame, the same
  // gesture CamScanner/most camera apps use when autofocus guesses wrong on
  // a close, low-contrast document. xFrac/yFrac are 0..1 within the visible
  // video frame. Returns false (quietly) on hardware/browsers that don't
  // expose pointsOfInterest, so the caller can skip showing feedback.
  async function focusAt(xFrac, yFrac) {
    try {
      const track = stream && stream.getVideoTracks()[0];
      if (!track || !track.getCapabilities) return false;
      const caps = track.getCapabilities();
      if (!caps.pointsOfInterest) return false;
      const advanced = { pointsOfInterest: [{ x: xFrac, y: yFrac }] };
      if (caps.focusMode && caps.focusMode.includes('single-shot')) advanced.focusMode = 'single-shot';
      else if (caps.focusMode && caps.focusMode.includes('continuous')) advanced.focusMode = 'continuous';
      await track.applyConstraints({ advanced: [advanced] });
      return true;
    } catch (e) {
      return false;
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

  // --- Document quad detection -------------------------------------------
  //
  // Classical pipeline, same shape real scanner apps use for this step:
  // blur -> Sobel edges -> non-max suppression (thin the edges) -> adaptive
  // threshold -> Hough transform (find the strongest straight lines) -> fit
  // the document's 4 sides from the two dominant, roughly-perpendicular
  // line directions -> order the 4 intersections as TL/TR/BR/BL. Operates
  // on a plain {data: Float32Array grayscale, w, h} buffer with no
  // DOM/canvas dependency in the core math, so it was unit-tested against
  // synthetic rotated-document images (various angles/noise levels) before
  // ever running against a real camera frame — see git history / PR notes
  // around v1.7.0 for that test harness. Two callers downscale a real
  // canvas/video frame into that buffer and scale the result back up:
  // autoDetectCorners() (after capture, higher resolution, one-shot) and
  // detectQuadFromVideoFrame() (live, lower resolution, polled — see
  // startLiveDetection() above).
  //
  // Known soft spot: a document rotated at *exactly* 45 degrees can
  // destabilize which pair of line directions gets picked as "the two
  // sides" (a tie-breaking edge case in the grouping step, not a crash) —
  // real photos are essentially never rotated at precisely 45.0 degrees,
  // so this wasn't chased further. Any failure mode here — this edge case,
  // a genuinely low-contrast document, an exception from an unsupported
  // canvas op — just means detectQuadCore() returns null, which both
  // callers already treat as "nothing confident found."

  function gaussianBlur(gray, w, h) {
    const k = [1, 4, 6, 4, 1], ksum = 16;
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let t = -2; t <= 2; t++) {
          const xx = Math.min(w - 1, Math.max(0, x + t));
          acc += gray[y * w + xx] * k[t + 2];
        }
        tmp[y * w + x] = acc / ksum;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let t = -2; t <= 2; t++) {
          const yy = Math.min(h - 1, Math.max(0, y + t));
          acc += tmp[yy * w + x] * k[t + 2];
        }
        out[y * w + x] = acc / ksum;
      }
    }
    return out;
  }

  function sobel(gray, w, h) {
    const mag = new Float32Array(w * h);
    const dir = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx =
          -gray[i - w - 1] + gray[i - w + 1] +
          -2 * gray[i - 1] + 2 * gray[i + 1] +
          -gray[i + w - 1] + gray[i + w + 1];
        const gy =
          -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] +
          gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
        mag[i] = Math.sqrt(gx * gx + gy * gy);
        let a = Math.atan2(gy, gx);
        if (a < 0) a += Math.PI;
        dir[i] = a;
      }
    }
    return { mag, dir };
  }

  function nonMaxSuppress(mag, dir, w, h) {
    const out = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const m = mag[i];
        if (m === 0) continue;
        const deg = (dir[i] * 180 / Math.PI) % 180;
        let n1, n2;
        if (deg < 22.5 || deg >= 157.5) { n1 = mag[i - 1]; n2 = mag[i + 1]; }
        else if (deg < 67.5) { n1 = mag[i - w + 1]; n2 = mag[i + w - 1]; }
        else if (deg < 112.5) { n1 = mag[i - w]; n2 = mag[i + w]; }
        else { n1 = mag[i - w - 1]; n2 = mag[i + w + 1]; }
        out[i] = (m >= n1 && m >= n2) ? m : 0;
      }
    }
    return out;
  }

  function binarizeEdges(mag, w, h) {
    let sum = 0, sumSq = 0, count = 0;
    for (let i = 0; i < w * h; i++) {
      if (mag[i] <= 0) continue;
      sum += mag[i]; sumSq += mag[i] * mag[i]; count++;
    }
    if (count === 0) return { edges: new Uint8Array(w * h), count: 0 };
    const mean = sum / count;
    const variance = Math.max(0, sumSq / count - mean * mean);
    const threshold = mean + Math.sqrt(variance) * 0.4; // post-NMS, so a looser k than a raw gradient map needs
    const edges = new Uint8Array(w * h);
    let edgeCount = 0;
    for (let i = 0; i < w * h; i++) {
      if (mag[i] > threshold) { edges[i] = 1; edgeCount++; }
    }
    return { edges, count: edgeCount };
  }

  function houghLines(edges, w, h, thetaSteps) {
    const diag = Math.ceil(Math.sqrt(w * w + h * h));
    const rhoOffset = diag;
    const rhoBins = diag * 2;
    const cosT = new Float32Array(thetaSteps);
    const sinT = new Float32Array(thetaSteps);
    for (let t = 0; t < thetaSteps; t++) {
      const theta = (t * Math.PI) / thetaSteps;
      cosT[t] = Math.cos(theta);
      sinT[t] = Math.sin(theta);
    }
    const accum = new Int32Array(thetaSteps * rhoBins);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!edges[y * w + x]) continue;
        for (let t = 0; t < thetaSteps; t++) {
          const rho = x * cosT[t] + y * sinT[t];
          const rb = Math.round(rho) + rhoOffset;
          if (rb < 0 || rb >= rhoBins) continue;
          accum[t * rhoBins + rb]++;
        }
      }
    }

    // Collect local-maxima peaks, suppressing a window around each chosen
    // peak so the same physical edge doesn't dominate the top-N list with
    // near-duplicate (theta,rho) entries.
    const peaks = [];
    const thetaWin = 4, rhoWin = 8;
    const minVotes = Math.max(8, Math.round(Math.min(w, h) * 0.05));
    for (let p = 0; p < 24; p++) {
      let best = -1, bestT = 0, bestR = 0;
      for (let t = 0; t < thetaSteps; t++) {
        for (let r = 0; r < rhoBins; r++) {
          const v = accum[t * rhoBins + r];
          if (v > best) { best = v; bestT = t; bestR = r; }
        }
      }
      if (best < minVotes) break;
      peaks.push({ theta: (bestT * Math.PI) / thetaSteps, rho: bestR - rhoOffset, votes: best });
      for (let dt = -thetaWin; dt <= thetaWin; dt++) {
        const tt = ((bestT + dt) % thetaSteps + thetaSteps) % thetaSteps;
        for (let dr = -rhoWin; dr <= rhoWin; dr++) {
          const rr = bestR + dr;
          if (rr < 0 || rr >= rhoBins) continue;
          accum[tt * rhoBins + rr] = 0;
        }
      }
    }
    return peaks;
  }

  function intersectLines(l1, l2) {
    const a1 = Math.cos(l1.theta), b1 = Math.sin(l1.theta), c1 = l1.rho;
    const a2 = Math.cos(l2.theta), b2 = Math.sin(l2.theta), c2 = l2.rho;
    const det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 1e-6) return null;
    return { x: (c1 * b2 - c2 * b1) / det, y: (a1 * c2 - a2 * c1) / det };
  }

  function angleDelta(a, b) {
    const d = Math.abs(a - b) % Math.PI;
    return Math.min(d, Math.PI - d);
  }

  function dominantPerpendicularAxes(lines) {
    // Vote-weighted histogram over line angle (mod 180deg, 18 bins of
    // 10deg) finds the two dominant edge directions directly, rather than
    // anchoring on whichever single line happened to get the most raw
    // Hough votes — that anchor approach misclassifies lines when the
    // document is rotated close to 45deg, where both edge directions end
    // up roughly equidistant from an arbitrary single-line anchor.
    const binCount = 18, binSize = Math.PI / binCount;
    const weight = new Float32Array(binCount);
    for (const l of lines) {
      const b = Math.floor((l.theta % Math.PI) / binSize) % binCount;
      weight[b] += l.votes;
    }
    let best = null;
    for (let b1 = 0; b1 < binCount; b1++) {
      for (let b2 = b1 + 1; b2 < binCount; b2++) {
        const a1 = (b1 + 0.5) * binSize, a2 = (b2 + 0.5) * binSize;
        const d = angleDelta(a1, a2);
        if (d < (70 * Math.PI / 180) || d > (110 * Math.PI / 180)) continue;
        const score = weight[b1] + weight[b2];
        if (!best || score > best.score) best = { score, a1, a2 };
      }
    }
    return best;
  }

  function fitQuadFromLines(lines) {
    if (lines.length < 4) return null;
    const axes = dominantPerpendicularAxes(lines);
    if (!axes) return null;
    const groupA = [], groupB = [];
    for (const l of lines) {
      if (angleDelta(l.theta, axes.a1) < (25 * Math.PI / 180)) groupA.push(l);
      else if (angleDelta(l.theta, axes.a2) < (25 * Math.PI / 180)) groupB.push(l);
    }
    if (groupA.length < 2 || groupB.length < 2) return null;

    function normalize(group) {
      const base = group[0].theta;
      return group.map((l) => {
        let theta = l.theta, rho = l.rho;
        if (Math.cos(theta - base) < 0) { theta -= Math.PI; rho = -rho; }
        return { theta, rho };
      });
    }
    const normA = normalize(groupA).sort((a, b) => a.rho - b.rho);
    const normB = normalize(groupB).sort((a, b) => a.rho - b.rho);
    const aLow = normA[0], aHigh = normA[normA.length - 1];
    const bLow = normB[0], bHigh = normB[normB.length - 1];

    const p1 = intersectLines(aLow, bLow);
    const p2 = intersectLines(aLow, bHigh);
    const p3 = intersectLines(aHigh, bHigh);
    const p4 = intersectLines(aHigh, bLow);
    if (!p1 || !p2 || !p3 || !p4) return null;
    return [p1, p2, p3, p4];
  }

  function orderCorners(pts) {
    const sums = pts.map((p) => p.x + p.y);
    const diffs = pts.map((p) => p.y - p.x);
    const tl = pts[sums.indexOf(Math.min(...sums))];
    const br = pts[sums.indexOf(Math.max(...sums))];
    const tr = pts[diffs.indexOf(Math.min(...diffs))];
    const bl = pts[diffs.indexOf(Math.max(...diffs))];
    return [tl, tr, br, bl];
  }

  function shoelaceArea(pts) {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return Math.abs(area / 2);
  }

  function detectQuadCore(gray, w, h, thetaSteps) {
    const blurred = gaussianBlur(gray, w, h);
    const { mag, dir } = sobel(blurred, w, h);
    const thin = nonMaxSuppress(mag, dir, w, h);
    const { edges, count } = binarizeEdges(thin, w, h);
    if (count < 20) return null;
    const lines = houghLines(edges, w, h, thetaSteps);
    const quad = fitQuadFromLines(lines);
    if (!quad) return null;
    const ordered = orderCorners(quad);
    const margin = Math.max(w, h) * 0.15;
    for (const p of ordered) {
      if (p.x < -margin || p.y < -margin || p.x > w + margin || p.y > h + margin) return null;
    }
    if (shoelaceArea(ordered) < w * h * 0.15) return null;
    return ordered;
  }

  function canvasToGray(canvas, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
    const w = Math.max(10, Math.round(canvas.width * scale));
    const h = Math.max(10, Math.round(canvas.height * scale));
    const small = document.createElement('canvas');
    small.width = w; small.height = h;
    const sctx = small.getContext('2d');
    sctx.drawImage(canvas, 0, 0, w, h);
    const { data } = sctx.getImageData(0, 0, w, h);
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    return { gray, w, h, scale };
  }

  function cornersAreSane(corners, imgW, imgH) {
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const spanW = Math.max(...xs) - Math.min(...xs);
    const spanH = Math.max(...ys) - Math.min(...ys);
    return spanW > imgW * 0.3 && spanH > imgH * 0.3;
  }

  // Post-capture: higher resolution, full theta precision, runs once — used
  // to seed the draggable crop handles. Always returns 4 corners (falls
  // back to a fixed inset on any failure, same contract as before this
  // rewrite), since the crop step needs a starting guess no matter what.
  function autoDetectCorners(sourceCanvas) {
    const fallback = defaultCorners(sourceCanvas.width, sourceCanvas.height);
    try {
      const { gray, w, h, scale } = canvasToGray(sourceCanvas, 560);
      const detected = detectQuadCore(gray, w, h, 180);
      if (!detected) return fallback;
      const scaled = detected.map((p) => ({ x: p.x / scale, y: p.y / scale }));
      return cornersAreSane(scaled, sourceCanvas.width, sourceCanvas.height) ? scaled : fallback;
    } catch (e) {
      return fallback;
    }
  }

  // Live preview: lower resolution, fewer theta steps, polled repeatedly
  // (see startLiveDetection above) — speed matters more than precision
  // here, since it's just a tracking outline, not the actual crop.
  // Returns null (not a fallback) when nothing confident is found, so the
  // caller can hide the live overlay instead of showing a fake box.
  function detectQuadFromVideoFrame(videoElement) {
    const vw = videoElement.videoWidth, vh = videoElement.videoHeight;
    if (!vw || !vh) return null;
    const maxDim = 320;
    const scale = Math.min(1, maxDim / Math.max(vw, vh));
    const w = Math.max(10, Math.round(vw * scale));
    const h = Math.max(10, Math.round(vh * scale));
    const small = document.createElement('canvas');
    small.width = w; small.height = h;
    const sctx = small.getContext('2d');
    sctx.drawImage(videoElement, 0, 0, w, h); // drawImage accepts a <video> source directly
    const { data } = sctx.getImageData(0, 0, w, h);
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    const detected = detectQuadCore(gray, w, h, 90);
    if (!detected) return null;
    const scaled = detected.map((p) => ({ x: p.x / scale, y: p.y / scale }));
    return cornersAreSane(scaled, vw, vh) ? scaled : null;
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

  return {
    startCamera, stopCamera, capturePhoto, warpToRectangle, defaultCorners,
    autoDetectCorners, enhanceCanvas, focusAt,
    startLiveDetection, stopLiveDetection, detectQuadFromVideoFrame
  };
})();
