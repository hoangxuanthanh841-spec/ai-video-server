/**
 * Production-ready AI Video Server (Cloud Run)
 * - POST /v1/video/concatenate
 *   Accepts body:
 *     { videos: string[] } OR
 *     { urls: string[] } OR
 *     { video_urls: string[] } OR
 *     { video_urls: [{ video_url: string }, ...] }
 * - Downloads videos to /tmp
 * - Tries fast concat (-c copy); if fails, falls back to re-encode (H.264 + AAC)
 * - Uploads result to Google Cloud Storage and returns public URL
 *
 * Required env:
 *   GCS_BUCKET=your-bucket-name
 * Optional env:
 *   GCS_PREFIX=merged
 *   MAX_VIDEOS=30
 *   DOWNLOAD_TIMEOUT_MS=600000
 *   FFMPEG_THREADS=2
 *   PORT=8080
 */

import express from "express";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import axios from "axios";
import crypto from "crypto";
import { Storage } from "@google-cloud/storage";

const app = express();
app.use(express.json({ limit: "5mb" })); // body is small (URLs), not video bytes

const PORT = Number(process.env.PORT || 8080);
const BUCKET = process.env.GCS_BUCKET;
const PREFIX = process.env.GCS_PREFIX || "merged";
const MAX_VIDEOS = Number(process.env.MAX_VIDEOS || 30);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 600000); // 10 min
const FFMPEG_THREADS = Number(process.env.FFMPEG_THREADS || 2);

if (!BUCKET) {
  console.warn("[WARN] Missing env GCS_BUCKET. Server will still run but upload will fail.");
}

const storage = new Storage();

app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

/** Utility: safe rm */
async function safeUnlink(p) {
  try { await fsp.unlink(p); } catch (_) {}
}

/** Utility: safe rmdir recursive for temp folder */
async function safeRmDir(p) {
  try { await fsp.rm(p, { recursive: true, force: true }); } catch (_) {}
}

/** Normalize request body into string[] urls */
function normalizeUrls(body) {
  const b = body || {};

  let arr =
    Array.isArray(b.videos) ? b.videos :
    Array.isArray(b.urls) ? b.urls :
    Array.isArray(b.video_urls) ? b.video_urls :
    [];

  // allow video_urls: [{video_url:"..."}]
  const urls = arr
    .map((v) => {
      if (typeof v === "string") return v;
      if (v && typeof v.video_url === "string") return v.video_url;
      return "";
    })
    .map((s) => String(s || "").trim())
    .filter(Boolean);

  return urls;
}

/** Download a URL to a local file path (stream) */
async function downloadToFile(url, outPath) {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxRedirects: 10,
    // IMPORTANT: don’t set headers unless required
    validateStatus: (s) => s >= 200 && s < 400,
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

/** Run ffmpeg concat using concat demuxer. If copy=true, try -c copy, else re-encode */
async function runConcat(listFile, outputFile, { copy }) {
  const base = ffmpeg()
    .input(listFile)
    .inputOptions(["-f concat", "-safe 0"])
    .output(outputFile)
    .on("start", (cmd) => console.log("[ffmpeg]", cmd))
    .on("progress", (p) => {
      // optional: noisy, comment out if needed
      // console.log("[ffmpeg progress]", p);
    });

  if (copy) {
    base.outputOptions(["-c copy"]);
  } else {
    base.outputOptions([
      "-threads", String(FFMPEG_THREADS),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
    ]);
  }

  await new Promise((resolve, reject) => {
    base.on("end", resolve).on("error", reject).run();
  });
}

/** Upload a file to GCS and return public URL */
async function uploadToGCS(localPath, destName) {
  if (!BUCKET) throw new Error("Missing GCS_BUCKET env");

  const bucket = storage.bucket(BUCKET);

  // Upload
  await bucket.upload(localPath, {
    destination: destName,
    resumable: false,
    metadata: {
      contentType: "video/mp4",
      cacheControl: "public, max-age=31536000",
    },
  });

  const file = bucket.file(destName);

  // Ensure public access via IAM or makePublic()
  // Recommended: set bucket IAM "allUsers: objectViewer" for this bucket/prefix.
  // As fallback (works if service account has permission):
  try {
    await file.makePublic();
  } catch (e) {
    console.warn("[WARN] makePublic failed (maybe bucket already public via IAM). Continuing.", e?.message || e);
  }

  return `https://storage.googleapis.com/${BUCKET}/${encodeURI(destName)}`;
}

app.post("/v1/video/concatenate", async (req, res) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const urls = normalizeUrls(req.body);

    if (!urls || urls.length < 2) {
      return res.status(400).json({
        success: false,
        error: "Need at least 2 video URLs",
        receivedKeys: Object.keys(req.body || {}),
        requestId,
      });
    }

    if (urls.length > MAX_VIDEOS) {
      return res.status(400).json({
        success: false,
        error: `Too many videos. Max is ${MAX_VIDEOS}`,
        count: urls.length,
        requestId,
      });
    }

    // Create per-request temp folder
    const workDir = path.join("/tmp", `job-${requestId}`);
    await fsp.mkdir(workDir, { recursive: true });

    // Download
    const localFiles = [];
    for (let i = 0; i < urls.length; i++) {
      const local = path.join(workDir, `in_${String(i).padStart(3, "0")}.mp4`);
      console.log(`[${requestId}] Download ${i + 1}/${urls.length}`);
      await downloadToFile(urls[i], local);
      localFiles.push(local);
    }

    // Build concat list file
    const listFile = path.join(workDir, "list.txt");
    const listContent = localFiles
      .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await fsp.writeFile(listFile, listContent, "utf8");

    const outputLocal = path.join(workDir, "output.mp4");

    // Try fast concat first
    try {
      console.log(`[${requestId}] Concat fast (-c copy)`);
      await runConcat(listFile, outputLocal, { copy: true });
    } catch (err) {
      console.warn(`[${requestId}] Fast concat failed, fallback to re-encode. Reason:`, err?.message || err);
      // Clean output if partially created
      await safeUnlink(outputLocal);

      console.log(`[${requestId}] Concat fallback (re-encode H.264/AAC)`);
      await runConcat(listFile, outputLocal, { copy: false });
    }

    // Upload to GCS
    const id = String(req.body?.id || requestId);
    const safeId = id.replace(/[^\w\-]/g, "_").slice(0, 80);
    const destName = `${PREFIX}/${safeId}-${Date.now()}.mp4`;

    console.log(`[${requestId}] Upload to GCS: gs://${BUCKET}/${destName}`);
    const url = await uploadToGCS(outputLocal, destName);

    const ms = Date.now() - startedAt;

    // Cleanup temp folder
    await safeRmDir(workDir);

    return res.json({
      success: true,
      url,
      requestId,
      ms,
      count: urls.length,
      modeUsed: "concat",
    });
  } catch (err) {
    console.error("[ERROR]", err);

    // Return readable error, not 503 silent crash
    return res.status(500).json({
      success: false,
      error: err?.message || String(err),
      requestId,
    });
  }
});

app.listen(PORT, () => {
  console.log(`AI Video Server listening on ${PORT}`);
});
