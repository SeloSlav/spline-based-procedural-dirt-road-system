import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/Asus/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const outputDir = path.join(projectDir, 'artifacts', 'showcase');
const metadataPath = path.join(outputDir, 'capture-metadata.json');
const finalVideoPath = path.join(outputDir, 'road-system-showcase-1080p.mp4');
const qaDir = path.join(outputDir, 'qa-frames');
const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
const rawVideoPath = metadata.rawVideoPath;
const musicPath = metadata.musicPath;

await fsp.mkdir(qaDir, { recursive: true });

function contentType(filePath) {
  if (filePath.endsWith('.webm')) return 'video/webm';
  if (filePath.endsWith('.mp4')) return 'video/mp4';
  if (filePath.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

async function serveMedia(request, response, filePath) {
  const stat = await fsp.stat(filePath);
  const range = request.headers.range;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': contentType(filePath),
  };

  if (!range) {
    response.writeHead(200, { ...headers, 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(response);
    return;
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    response.end();
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  response.writeHead(206, {
    ...headers,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
  });
  fs.createReadStream(filePath, { start, end }).pipe(response);
}

const editorHtml = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style></head>
<body>
  <video id="source" src="/source" preload="auto" muted playsinline hidden></video>
  <audio id="music" src="/music" preload="auto" playsinline hidden></audio>
  <canvas id="stage" width="1920" height="1080"></canvas>
  <script>
    const once = (target, event) => new Promise((resolve, reject) => {
      const onError = () => reject(target.error ?? new Error(event + ' failed'));
      target.addEventListener(event, resolve, { once: true });
      target.addEventListener('error', onError, { once: true });
    });
    const ensureMetadata = async (media) => {
      if (media.readyState >= 1) return;
      await once(media, 'loadedmetadata');
    };
    const seek = async (media, seconds) => {
      if (Math.abs(media.currentTime - seconds) < 0.01) return;
      const ready = once(media, 'seeked');
      media.currentTime = seconds;
      await ready;
    };

    window.renderShowcase = async ({ leadSeconds, durationSeconds }) => {
      const source = document.querySelector('#source');
      const music = document.querySelector('#music');
      const canvas = document.querySelector('#stage');
      const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
      await Promise.all([ensureMetadata(source), ensureMetadata(music)]);
      await Promise.all([seek(source, leadSeconds), seek(music, 0)]);

      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const canvasStream = canvas.captureStream(30);
      const audioContext = new AudioContext({ sampleRate: 48000 });
      const mediaSource = audioContext.createMediaElementSource(music);
      const gain = audioContext.createGain();
      const audioDestination = audioContext.createMediaStreamDestination();
      mediaSource.connect(gain).connect(audioDestination);
      const now = audioContext.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.24, now + 0.8);
      gain.gain.setValueAtTime(0.24, now + durationSeconds - 1.3);
      gain.gain.linearRampToValueAtTime(0, now + durationSeconds);

      const stream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioDestination.stream.getAudioTracks(),
      ]);
      const candidates = [
        'video/mp4;codecs=avc1.640028,mp4a.40.2',
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4',
      ];
      const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
      if (!mimeType) throw new Error('This Chromium build cannot record H.264/AAC MP4.');
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 12_000_000,
        audioBitsPerSecond: 192_000,
      });
      const chunks = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      const stopped = once(recorder, 'stop');

      await audioContext.resume();
      recorder.start(1000);
      await Promise.all([source.play(), music.play()]);
      const sourceStart = leadSeconds;

      await new Promise((resolve) => {
        const paint = () => {
          const elapsed = Math.max(0, source.currentTime - sourceStart);
          context.globalAlpha = 1;
          context.drawImage(source, 0, 0, canvas.width, canvas.height);
          let black = 0;
          if (elapsed < 0.25) black = 1 - elapsed / 0.25;
          if (elapsed > durationSeconds - 0.42) {
            black = Math.max(black, (elapsed - (durationSeconds - 0.42)) / 0.42);
          }
          if (black > 0) {
            context.fillStyle = 'rgba(0,0,0,' + Math.min(1, black) + ')';
            context.fillRect(0, 0, canvas.width, canvas.height);
          }
          if (elapsed >= durationSeconds) {
            resolve();
            return;
          }
          requestAnimationFrame(paint);
        };
        requestAnimationFrame(paint);
      });

      source.pause();
      music.pause();
      recorder.stop();
      await stopped;
      canvasStream.getTracks().forEach((track) => track.stop());
      audioDestination.stream.getTracks().forEach((track) => track.stop());
      await audioContext.close();

      const blob = new Blob(chunks, { type: mimeType });
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(blob);
      anchor.download = 'road-system-showcase-1080p.mp4';
      document.body.append(anchor);
      anchor.click();
      return { mimeType, bytes: blob.size };
    };
  </script>
</body>
</html>`;

const qaHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}video{width:1920px;height:1080px;display:block}
</style></head><body><video id="qa" src="/final" preload="auto" playsinline></video></body></html>`;

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/source') return await serveMedia(request, response, rawVideoPath);
    if (request.url === '/music') return await serveMedia(request, response, musicPath);
    if (request.url === '/final') return await serveMedia(request, response, finalVideoPath);
    if (request.url === '/qa') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(qaHtml);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(editorHtml);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(String(error));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Users/Asus/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--enable-gpu-rasterization',
    '--ignore-gpu-blocklist',
    '--use-angle=d3d11',
  ],
});
const context = await browser.newContext({
  acceptDownloads: true,
  viewport: { width: 1920, height: 1080 },
});
const page = await context.newPage();
await page.goto(baseUrl, { waitUntil: 'load' });

const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
const renderResult = await page.evaluate((config) => window.renderShowcase(config), {
  leadSeconds: Number(metadata.leadSeconds),
  durationSeconds: Number(metadata.storySeconds),
});
const download = await downloadPromise;
await download.saveAs(finalVideoPath);

const qaPage = await context.newPage();
await qaPage.goto(`${baseUrl}/qa`, { waitUntil: 'load' });
await qaPage.locator('#qa').evaluate((video) => new Promise((resolve, reject) => {
  if (video.readyState >= 1) resolve();
  else {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', () => reject(video.error), { once: true });
  }
}));

const qaSeconds = [0.6, 3.0, 6.8, 9.6, 13.7, 16.6, 19.8, 22.5, 25.5, 28.3];
for (const seconds of qaSeconds) {
  await qaPage.locator('#qa').evaluate((video, time) => new Promise((resolve, reject) => {
    const done = () => resolve();
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', () => reject(video.error), { once: true });
    video.currentTime = time;
  }), seconds);
  await qaPage.waitForTimeout(120);
  await qaPage.screenshot({ path: path.join(qaDir, `frame-${seconds.toFixed(1)}s.png`) });
}

const verification = await qaPage.locator('#qa').evaluate(async (video) => {
  video.muted = true;
  await video.play();
  await new Promise((resolve) => setTimeout(resolve, 180));
  const captured = video.captureStream();
  const result = {
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
    videoTracks: captured.getVideoTracks().length,
    audioTracks: captured.getAudioTracks().length,
  };
  captured.getTracks().forEach((track) => track.stop());
  video.pause();
  return result;
});

await context.close();
await browser.close();
server.close();

console.log(JSON.stringify({
  finalVideoPath,
  bytes: (await fsp.stat(finalVideoPath)).size,
  qaDir,
  renderResult,
  verification,
}, null, 2));
