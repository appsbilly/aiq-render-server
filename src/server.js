// render-server/src/server.js — Bulletproof FFmpeg
//
// Caption strategy: write captions to an .ass (Advanced SubStation) file and burn in
// via the subtitles filter. This avoids the brittle drawtext escaping issues entirely.
// .ass files handle apostrophes, colons, percent signs, emojis, and unicode natively.
//
// Pipeline:
//   1. Download silent DoP video + audio
//   2. If captions exist: write .ass subtitle file
//   3. FFmpeg: loop-stretch silent video, add audio, burn subtitles, scale 1080x1920
//   4. Upload, create post, trigger safety

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
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function notifyDiscord(opts) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            title: opts.title,
            description: opts.description,
            color: opts.color === 'success' ? 0x10b981 : opts.color === 'error' ? 0xef4444 : 0x3b82f6,
            fields: opts.fields,
            url: opts.url,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
  } catch (e) {
    console.error('Discord notify failed:', e);
  }
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'aiq-render-server', mode: 'webhook-v2' });
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

// Format seconds as ASS-style timestamp: h:mm:ss.cc (centiseconds)
function assTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const cs = Math.floor((secs - Math.floor(secs)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// Sanitize text for ASS subtitle format
// ASS uses {} for inline codes, \N for newline. We escape literal { and } and replace newlines.
function assEscape(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

// Build an ASS subtitle file. Returns the file content as a string.
function buildAssFile(onScreenText, totalDuration) {
  if (!onScreenText || onScreenText.length === 0) return null;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'Timer: 100.0000',
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Default style (white on black box)
    'Style: Default,DejaVuSans,56,&H00FFFFFF,&H000000FF,&H00000000,&HCC000000,1,0,0,0,100,100,0,0,3,0,8,40,40,400,1',
    // Highlight style (white on purple box)
    'Style: Highlight,DejaVuSans,72,&H00FFFFFF,&H000000FF,&H00000000,&HD9AD377C,1,0,0,0,100,100,0,0,3,0,8,40,40,400,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = onScreenText.map((overlay, i) => {
    const start = Math.max(0, Number(overlay.start_time_sec ?? 0));
    const nextStart = Number(onScreenText[i + 1]?.start_time_sec ?? totalDuration);
    const end = Math.min(start + 2.5, nextStart, totalDuration);
    if (end <= start) return null;

    const isHighlight = overlay.emphasis === 'highlight';
    const style = isHighlight ? 'Highlight' : 'Default';
    const text = assEscape(overlay.text || '');

    return `Dialogue: 0,${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`;
  }).filter(Boolean);

  return header.concat(events).join('\n') + '\n';
}

async function uploadFinalVideo(scriptId, localPath) {
  const storagePath = `videos/${scriptId}.mp4`;
  const buf = await fs.readFile(localPath);
  const { error } = await supabase.storage
    .from('content-assets')
    .upload(storagePath, buf, { contentType: 'video/mp4', upsert: true });
  if (error) throw error;
  const { data } = await supabase.storage
    .from('content-assets')
    .createSignedUrl(storagePath, 60 * 60 * 24 * 30);
  if (!data?.signedUrl) throw new Error('Failed to sign final video URL');
  return { videoUrl: data.signedUrl, storagePath };
}

function extractVideoUrl(payload) {
  if (!payload) return null;
  if (payload?.results?.raw?.url) return payload.results.raw.url;
  if (payload?.results?.min?.url) return payload.results.min.url;
  if (payload?.url) return payload.url;
  if (Array.isArray(payload?.jobs)) {
    for (const job of payload.jobs) {
      if (job.status === 'completed') {
        if (job.results?.raw?.url) return job.results.raw.url;
        if (job.results?.min?.url) return job.results.min.url;
      }
    }
  }
  return null;
}

function extractJobSetId(payload) {
  return payload?.id || payload?.job_set_id || payload?.request_id || null;
}

function extractStatus(payload) {
  if (!payload) return 'unknown';
  const top = (payload.status || '').toLowerCase();
  if (top) return top;
  if (Array.isArray(payload.jobs)) {
    if (payload.jobs.some((j) => ['failed', 'nsfw', 'cancelled'].includes(j.status))) return 'failed';
    if (payload.jobs.every((j) => j.status === 'completed')) return 'completed';
    return 'pending';
  }
  return extractVideoUrl(payload) ? 'completed' : 'unknown';
}

app.post('/dop-callback', async (req, res) => {
  const cbId = randomUUID().slice(0, 8);
  console.log(`[${cbId}] dop-callback received`);

  const token = req.query.token;
  if (!RENDER_SERVER_TOKEN || token !== RENDER_SERVER_TOKEN) {
    console.warn(`[${cbId}] unauthorized callback`);
    return res.status(401).json({ error: 'unauthorized' });
  }

  res.status(200).json({ received: true });
  processCallback(cbId, req.body).catch((err) => {
    console.error(`[${cbId}] processCallback error:`, err);
    notifyDiscord({
      title: '❌ DoP callback handler crashed',
      description: String(err),
      color: 'error',
    });
  });
});

async function processCallback(cbId, payload) {
  console.log(`[${cbId}] processing`, JSON.stringify(payload).slice(0, 300));

  const status = extractStatus(payload);
  const jobSetId = extractJobSetId(payload);

  if (!jobSetId) throw new Error('No job_set_id in webhook payload');

  const { data: job, error: jobErr } = await supabase
    .from('content_jobs')
    .select('*, content_scripts(*, content_contrast_pairs(title))')
    .eq('external_job_id', jobSetId)
    .single();

  if (jobErr || !job) throw new Error(`No content_jobs row for ${jobSetId}`);

  if (status === 'failed' || status === 'nsfw' || status === 'cancelled') {
    await supabase.from('content_jobs').update({
      status: 'failed',
      error_message: payload?.error || `status=${status}`,
      payload_out: payload,
      completed_at: new Date().toISOString(),
    }).eq('id', job.id);

    await supabase.from('content_scripts').update({ status: 'failed' }).eq('id', job.script_id);

    await notifyDiscord({
      title: '❌ DoP video generation failed',
      description: `Job ${jobSetId}: ${payload?.error || status}`,
      color: 'error',
    });
    return;
  }

  if (status !== 'completed') {
    console.log(`[${cbId}] status=${status}, ignoring`);
    return;
  }

  const silentVideoUrl = extractVideoUrl(payload);
  if (!silentVideoUrl) throw new Error('Status=completed but no video URL');

  console.log(`[${cbId}] DoP video URL: ${silentVideoUrl.slice(0, 100)}`);

  const workDir = join(tmpdir(), `aiq-cb-${cbId}`);
  await fs.mkdir(workDir, { recursive: true });

  const silentVideoPath = join(workDir, 'silent.mp4');
  const audioPath = join(workDir, 'audio.mp3');
  const subtitlePath = join(workDir, 'captions.ass');
  const outputPath = join(workDir, 'output.mp4');

  try {
    await Promise.all([
      downloadToFile(silentVideoUrl, silentVideoPath),
      downloadToFile(job.audio_url, audioPath),
    ]);
    console.log(`[${cbId}] downloads complete`);

    const audioProbe = await probe(audioPath);
    const audioDuration = audioProbe.format.duration ?? 30;
    console.log(`[${cbId}] audio duration: ${audioDuration.toFixed(2)}s`);

    const script = job.content_scripts;
    const onScreenText = script?.on_screen_text ?? [];
    const assContent = buildAssFile(onScreenText, audioDuration);

    let useCaptions = false;
    if (assContent) {
      try {
        await fs.writeFile(subtitlePath, assContent);
        useCaptions = true;
        console.log(`[${cbId}] wrote ${onScreenText.length} captions to .ass file`);
      } catch (e) {
        console.warn(`[${cbId}] caption file write failed, skipping captions:`, e);
      }
    }

    // Build the FFmpeg command using simpler -vf instead of complexFilter when possible
    // The subtitles filter needs an absolute path with escaped colons on some systems
    const escapedSubPath = subtitlePath.replace(/:/g, '\\:').replace(/'/g, "\\'");

    const videoFilters = [
      'scale=1080:1920:force_original_aspect_ratio=increase',
      'crop=1080:1920',
    ];
    if (useCaptions) {
      videoFilters.push(`subtitles='${escapedSubPath}'`);
    }

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg()
        .input(silentVideoPath)
        .inputOptions(['-stream_loop', '-1'])
        .input(audioPath)
        .videoFilters(videoFilters.join(','))
        .outputOptions([
          '-map', '0:v',
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
        .output(outputPath);

      cmd.on('start', (cmdline) => {
        console.log(`[${cbId}] ffmpeg cmd: ${cmdline.slice(0, 500)}`);
      });
      cmd.on('end', () => {
        console.log(`[${cbId}] ffmpeg done`);
        resolve();
      });
      cmd.on('error', (err, stdout, stderr) => {
        console.error(`[${cbId}] ffmpeg error:`, err.message);
        if (stderr) console.error(`[${cbId}] ffmpeg stderr:`, stderr.slice(-2000));
        reject(err);
      });
      cmd.run();
    });

    const { videoUrl, storagePath } = await uploadFinalVideo(job.script_id, outputPath);
    console.log(`[${cbId}] uploaded: ${storagePath}`);

    const { data: asset, error: assetError } = await supabase
      .from('content_assets')
      .insert({
        script_id: job.script_id,
        external_url: videoUrl,
        storage_path: storagePath,
        generation_tool: 'higgsfield_dop+render_server_v2',
        generation_cost_cents: 50,
        duration_seconds: audioDuration,
      })
      .select()
      .single();

    if (assetError) throw assetError;

    await supabase
      .from('content_jobs')
      .update({
        status: 'completed',
        payload_out: payload,
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    await supabase
      .from('content_scripts')
      .update({ status: 'rendered' })
      .eq('id', job.script_id);

    const { data: post, error: postError } = await supabase
      .from('content_posts')
      .insert({
        asset_id: asset.id,
        platform: script.platform,
        caption: script.platform_caption,
        status: 'safety_check',
      })
      .select()
      .single();

    if (postError) throw postError;

    fetch(`${SUPABASE_URL}/functions/v1/safety-checker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ post_id: post.id }),
    }).catch((e) => console.error('Safety check trigger failed:', e));

    await notifyDiscord({
      title: '✅ Video rendered fully automated',
      description: `**${script?.content_contrast_pairs?.title}** • ${script.platform}`,
      color: 'success',
      fields: [
        { name: 'Asset ID', value: asset.id, inline: true },
        { name: 'Post ID', value: post.id, inline: true },
        { name: 'Duration', value: `${audioDuration.toFixed(1)}s`, inline: true },
      ],
      url: videoUrl,
    });

    try {
      await fs.unlink(silentVideoPath);
      await fs.unlink(audioPath);
      await fs.unlink(outputPath);
      if (useCaptions) await fs.unlink(subtitlePath);
    } catch {}
  } catch (err) {
    console.error(`[${cbId}] callback error:`, err);
    await supabase
      .from('content_jobs')
      .update({
        status: 'failed',
        error_message: String(err),
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id);
    await supabase
      .from('content_scripts')
      .update({ status: 'failed' })
      .eq('id', job.script_id);
    await notifyDiscord({
      title: '❌ Render server error',
      description: String(err).slice(0, 1000),
      color: 'error',
      fields: [{ name: 'Job ID', value: jobSetId, inline: true }],
    });
    throw err;
  }
}

app.listen(PORT, () => {
  console.log(`AiQ render server (webhook-v2) listening on :${PORT}`);
});
