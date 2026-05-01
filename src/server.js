// render-server/src/server.js — Plan A v2
// Combines silent DoP video + MP3 audio + caption overlays
// FFmpeg handles MP3/WAV/etc natively, no pre-conversion needed

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const app = express();
app.use(express.json({ limit: '10mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RENDER_SERVER_TOKEN = process.env.RENDER_SERVER_TOKEN;
const PORT = process.env.PORT || 3001;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function authenticate(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/, '');
  if (!RENDER_SERVER_TOKEN || token !== RENDER_SERVER_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'aiq-render-server', mode: 'plan-a-v2' });
});

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
  return destPath;
}

function probe(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function buildDrawtextFilters(onScreenText, totalDuration) {
  if (!onScreenText || onScreenText.length === 0) return [];

  return onScreenText.map((overlay, i) => {
    const text = String(overlay.text)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/:/g, '\\:')
      .replace(/%/g, '\\%');

    const start = Math.max(0, overlay.start_time_sec ?? 0);
    const nextStart = onScreenText[i + 1]?.start_time_sec ?? totalDuration;
    const end = Math.min(start + 2.5, nextStart, totalDuration);

    if (end <= start) return null;

    const isHighlight = overlay.emphasis === 'highlight';
    const fontSize = isHighlight ? 72 : 56;
    const bgColor = isHighlight ? '0x7C3AED@0.85' : '0x000000@0.7';

    return (
      `drawtext=text='${text}':` +
      `fontcolor=#FFFFFF:` +
      `fontsize=${fontSize}:` +
      `font=Arial-Bold:` +
      `box=1:boxcolor=${bgColor}:boxborderw=18:` +
      `x=(w-text_w)/2:` +
      `y=h*0.78:` +
      `enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`
    );
  }).filter(Boolean);
}

async function uploadFinalVideo(scriptId, localPath) {
  const storagePath = `videos/${scriptId}.mp4`;
  const buf = await fs.readFile(localPath);
  const { error } = await supabase.storage
    .from('content-assets')
    .upload(storagePath, buf, {
      contentType: 'video/mp4',
      upsert: true,
    });

  if (error) throw error;

  const { data } = await supabase.storage
    .from('content-assets')
    .createSignedUrl(storagePath, 60 * 60 * 24 * 30);

  if (!data?.signedUrl) throw new Error('Failed to sign final video URL');

  return { videoUrl: data.signedUrl, storagePath };
}

app.post('/render', authenticate, async (req, res) => {
  const jobId = randomUUID().slice(0, 8);
  const workDir = join(tmpdir(), `aiq-render-${jobId}`);
  await fs.mkdir(workDir, { recursive: true });
  console.log(`[${jobId}] start render in ${workDir}`);

  try {
    const { script_id, silent_video_url, audio_url, on_screen_text } = req.body;

    if (!script_id || !silent_video_url || !audio_url) {
      return res.status(400).json({
        error: 'script_id, silent_video_url, audio_url required',
      });
    }

    const silentVideoPath = join(workDir, 'silent.mp4');
    const audioPath = join(workDir, 'audio.mp3');     // ffmpeg autodetects format
    const outputPath = join(workDir, 'output.mp4');

    await Promise.all([
      downloadToFile(silent_video_url, silentVideoPath),
      downloadToFile(audio_url, audioPath),
    ]);
    console.log(`[${jobId}] downloaded inputs`);

    const audioProbe = await probe(audioPath);
    const audioDuration = audioProbe.format.duration ?? 30;
    console.log(`[${jobId}] audio duration: ${audioDuration.toFixed(2)}s`);

    const drawtextFilters = buildDrawtextFilters(on_screen_text, audioDuration);

    const videoFilters = [
      `scale=1080:1920:force_original_aspect_ratio=increase`,
      `crop=1080:1920`,
      ...drawtextFilters,
    ];

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(silentVideoPath)
        .inputOptions(['-stream_loop', '-1'])
        .input(audioPath)
        .complexFilter([
          {
            filter: videoFilters.join(','),
            inputs: '0:v',
            outputs: 'v',
          },
        ])
        .outputOptions([
          '-map', '[v]',
          '-map', '1:a',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-shortest',
          '-t', String(audioDuration),
          '-movflags', '+faststart',
          '-r', '30',
        ])
        .output(outputPath)
        .on('end', () => {
          console.log(`[${jobId}] ffmpeg done`);
          resolve();
        })
        .on('error', (err) => {
          console.error(`[${jobId}] ffmpeg error:`, err.message);
          reject(err);
        })
        .run();
    });

    const { videoUrl, storagePath } = await uploadFinalVideo(script_id, outputPath);
    console.log(`[${jobId}] uploaded: ${storagePath}`);

    try {
      await fs.unlink(silentVideoPath);
      await fs.unlink(audioPath);
      await fs.unlink(outputPath);
    } catch {}

    res.json({
      video_url: videoUrl,
      storage_path: storagePath,
      duration_seconds: audioDuration,
    });
  } catch (err) {
    console.error(`[${jobId}] render failed:`, err);
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`AiQ render server (Plan A v2) listening on :${PORT}`);
});
