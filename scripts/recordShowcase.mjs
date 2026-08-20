import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/Asus/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const outputDir = path.join(projectDir, 'artifacts', 'showcase');
const videoScratchDir = path.join(outputDir, 'playwright-video');
const metadataPath = path.join(outputDir, 'capture-metadata.json');
const rawVideoPath = path.join(outputDir, 'road-system-showcase-raw.webm');
const probeOnly = process.argv.includes('--probe');

await fs.mkdir(videoScratchDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Users/Asus/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  args: [
    '--enable-webgpu',
    '--enable-gpu-rasterization',
    '--ignore-gpu-blocklist',
    '--use-angle=d3d11',
  ],
});

const contextOptions = {
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
};
if (!probeOnly) {
  contextOptions.recordVideo = {
    dir: videoScratchDir,
    size: { width: 1920, height: 1080 },
  };
}

const context = await browser.newContext(contextOptions);
const createdAt = Date.now();
const page = await context.newPage();
const pageVideo = probeOnly ? null : page.video();

page.on('console', (message) => {
  if (message.type() === 'error') console.error(`[browser] ${message.text()}`);
});

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 60_000 });
await page.locator('canvas').waitFor({ state: 'visible', timeout: 60_000 });
await page.locator('[data-zoom]').waitFor({ state: 'visible', timeout: 60_000 });
await page.waitForFunction(() => {
  const value = Number.parseFloat(document.querySelector('[data-fps]')?.textContent ?? '0');
  return Number.isFinite(value) && value > 1;
}, { timeout: 60_000 });
await page.waitForFunction(() => (
  document.documentElement.dataset.environmentReady === 'true'
), { timeout: 180_000 });
// Give the first complete foliage and shadow frames time to reach the video surface.
await page.waitForTimeout(1_500);

if (probeOnly) {
  const probePath = path.join(outputDir, 'probe-1080p.png');
  await page.screenshot({ path: probePath });
  console.log(JSON.stringify({
    probePath,
    zoom: await page.locator('[data-zoom]').textContent(),
    fps: await page.locator('[data-fps]').textContent(),
  }, null, 2));
  await context.close();
  await browser.close();
  process.exit(0);
}

await page.evaluate(() => {
  const style = document.createElement('style');
  style.textContent = `
    #showcase-caption {
      position: fixed;
      z-index: 10000;
      top: 104px;
      left: 50%;
      width: min(900px, calc(100vw - 760px));
      transform: translate(-50%, -8px);
      padding: 16px 26px 18px;
      border: 1px solid rgba(236, 205, 132, 0.34);
      border-radius: 10px;
      color: #fff9e8;
      text-align: center;
      font-family: Inter, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, rgba(15, 20, 15, 0.91), rgba(13, 18, 14, 0.74));
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.25), inset 0 1px rgba(255, 255, 255, 0.04);
      backdrop-filter: blur(7px);
      opacity: 0;
      transition: opacity 220ms ease, transform 220ms ease;
      pointer-events: none;
    }
    #showcase-caption.is-visible { opacity: 1; transform: translate(-50%, 0); }
    #showcase-caption.is-hero { top: 138px; padding: 22px 34px 25px; }
    #showcase-caption .kicker {
      margin-bottom: 7px;
      color: #e9c66f;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    #showcase-caption .title {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 39px;
      font-weight: 700;
      line-height: 1.05;
      letter-spacing: -0.02em;
      text-shadow: 0 2px 18px rgba(0, 0, 0, 0.42);
    }
    #showcase-caption.is-hero .title { font-size: 49px; }
    #showcase-caption .sub {
      margin-top: 8px;
      color: rgba(245, 241, 224, 0.82);
      font-size: 19px;
      font-weight: 500;
      letter-spacing: 0.01em;
    }
    #showcase-cursor {
      position: fixed;
      z-index: 10001;
      width: 30px;
      height: 30px;
      margin: -15px 0 0 -15px;
      border: 2px solid rgba(255, 231, 164, 0.95);
      border-radius: 50%;
      box-shadow: 0 0 0 4px rgba(31, 24, 12, 0.28), 0 0 22px rgba(235, 193, 92, 0.55);
      pointer-events: none;
    }
    #showcase-cursor::after {
      content: "";
      position: absolute;
      inset: 10px;
      border-radius: 50%;
      background: #f2cc72;
    }
    .showcase-ripple {
      position: fixed;
      z-index: 10000;
      width: 22px;
      height: 22px;
      margin: -11px 0 0 -11px;
      border: 2px solid rgba(255, 232, 166, 0.9);
      border-radius: 50%;
      pointer-events: none;
      animation: showcase-ripple 520ms ease-out forwards;
    }
    @keyframes showcase-ripple {
      to { opacity: 0; transform: scale(3.3); }
    }
  `;
  document.head.append(style);

  const caption = document.createElement('section');
  caption.id = 'showcase-caption';
  caption.innerHTML = '<div class="kicker"></div><div class="title"></div><div class="sub"></div>';
  document.body.append(caption);

  const cursor = document.createElement('div');
  cursor.id = 'showcase-cursor';
  cursor.style.left = '960px';
  cursor.style.top = '540px';
  document.body.append(cursor);

  window.addEventListener('mousemove', (event) => {
    cursor.style.left = `${event.clientX}px`;
    cursor.style.top = `${event.clientY}px`;
  }, true);
  window.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    const ripple = document.createElement('div');
    ripple.className = 'showcase-ripple';
    ripple.style.left = `${event.clientX}px`;
    ripple.style.top = `${event.clientY}px`;
    document.body.append(ripple);
    window.setTimeout(() => ripple.remove(), 560);
  }, true);

  window.__setShowcaseCaption = ({ kicker, title, sub, hero = false, visible = true }) => {
    caption.querySelector('.kicker').textContent = kicker;
    caption.querySelector('.title').textContent = title;
    caption.querySelector('.sub').textContent = sub;
    caption.classList.toggle('is-hero', hero);
    caption.classList.toggle('is-visible', visible);
  };
});

const readyAt = Date.now();
const storyStart = Date.now();
const storyDurationMs = 30_000;

async function at(milliseconds) {
  const wait = milliseconds - (Date.now() - storyStart);
  if (wait > 0) await page.waitForTimeout(wait);
}

async function caption(kicker, title, sub, hero = false) {
  await page.evaluate(({ kicker, title, sub, hero }) => {
    window.__setShowcaseCaption({ kicker, title, sub, hero });
  }, { kicker, title, sub, hero });
}

async function moveAndClick(x, y, steps = 18) {
  await page.mouse.move(x, y, { steps });
  await page.waitForTimeout(90);
  await page.mouse.click(x, y);
}

async function wheelBurst(deltaY, count, gapMs = 105) {
  for (let index = 0; index < count; index += 1) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(gapMs);
  }
}

await caption(
  'THREE.JS · PROCEDURAL TOOLING',
  'Author terrain-aware road networks in real time',
  'A spline editor for city builders, strategy games and simulation tools',
  true,
);

await at(2_000);
await caption(
  'SCALE-AWARE CAMERA',
  'Move from world overview to construction detail',
  'RTS navigation with a 30–1000% inspection range',
);
await page.mouse.move(960, 520, { steps: 24 });
await wheelBurst(-90, 5, 115);

await at(3_150);
await caption(
  'TERRAIN-CONFORMING SPLINES',
  'Draw a route, then shape the curve',
  'Control points follow the terrain · Ctrl + wheel bends the pending segment',
);
await moveAndClick(490, 340);
await at(4_000);
await moveAndClick(690, 330);
await at(4_900);
await page.mouse.move(1090, 340, { steps: 34 });
await at(5_350);
await wheelBurst(-90, 3, 110);
await page.keyboard.down('Control');
await page.mouse.wheel(0, -220);
await page.keyboard.up('Control');

await at(6_300);
await caption(
  'AUTOMATIC RIVER CROSSINGS',
  'Cross water → get a complete timber bridge',
  'Deck, supports and railings are generated from the spline span',
);
await moveAndClick(1090, 340, 12);
await at(7_400);
await page.keyboard.press('Enter');

await at(9_250);
await caption(
  'CONNECTED ROAD GRAPH',
  'Snap to an endpoint and keep building',
  'Routes rebuild as a single editable network',
);
await moveAndClick(1090, 340);
await at(10_250);
await moveAndClick(1480, 390, 30);
await at(10_850);
await page.keyboard.press('Enter');

await at(12_100);
await caption(
  'BURGAGE PLOT AUTHORING',
  'Snap frontage, then drag the rear boundary',
  'Four points define terrain-hugging roadside parcels',
);
await page.getByRole('button', { name: 'Toggle house placement mode', exact: true }).click();
await at(12_700);
await moveAndClick(990, 350);
await at(13_450);
await moveAndClick(1450, 410, 28);
await at(14_250);
await moveAndClick(1500, 620, 26);
await at(15_050);
await moveAndClick(1020, 570, 34);

await at(16_200);
await caption(
  'ADJUSTABLE PARCELS',
  'Change the plot count before construction',
  'Validation, house footprints and dividers update instantly',
);
await page.keyboard.press('-');
await at(16_850);
await page.keyboard.press('+');
await at(17_700);
await page.keyboard.press('Enter');

await at(19_150);
await caption(
  'INSTANT GAMEPLAY OUTPUT',
  'Terrain-aligned cottages, yards and fences',
  'Placement also exposes connection points for future access roads',
);

await at(21_350);
await caption(
  'TOPOLOGY-AWARE JUNCTIONS',
  'Drop a branch onto any road segment',
  'The network splits and rebuilds a clean intersection automatically',
);
await page.getByRole('button', { name: 'Toggle road tool', exact: true }).click();
await moveAndClick(1190, 365);
await at(22_350);
await moveAndClick(1260, 135, 30);
await at(23_000);
await page.keyboard.press('Enter');

await at(24_300);
await caption(
  'BUILT FOR GAME DEVELOPERS',
  'Spline roads, bridges, plots and junctions — one system',
  'Interactive, terrain-aware and ready to adapt to your world',
  true,
);
await page.mouse.move(960, 540, { steps: 26 });
await wheelBurst(90, 3, 130);

await at(27_300);
await caption(
  'SPLINE-BASED PROCEDURAL ROAD SYSTEM',
  'Build the network your simulation needs',
  'Three.js · automatic crossings · connected topology · roadside plots',
  true,
);

await at(storyDurationMs);
await page.waitForTimeout(350);

const capture = {
  width: 1920,
  height: 1080,
  fps: 30,
  leadSeconds: (readyAt - createdAt) / 1000,
  storySeconds: storyDurationMs / 1000,
  musicPath: 'C:/WebProjects/medieval-road-system/public/sounds/music/roads_and_rooftops.mp3',
  rawVideoPath,
};

await fs.writeFile(metadataPath, `${JSON.stringify(capture, null, 2)}\n`, 'utf8');
await context.close();
await browser.close();

const recordedPath = await pageVideo.path();
await fs.copyFile(recordedPath, rawVideoPath);
console.log(JSON.stringify({ ...capture, metadataPath }, null, 2));
