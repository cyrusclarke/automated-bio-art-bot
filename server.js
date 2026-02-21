const express = require('express');
const puppeteer = require('puppeteer-core');
const sharp = require('sharp');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const GRID_COLS = 48;
const GRID_ROWS = 32;

// Bacteria color palette
const PALETTE = [
  { name: 'erase', hex: '#ffffff', rgb: [255, 255, 255] },
  { name: 'sfGFP', hex: '#1fea5c', rgb: [31, 234, 92] },
  { name: 'mRFP1', hex: '#8f2438', rgb: [143, 36, 56] },
  { name: 'mKO2', hex: '#b39223', rgb: [179, 146, 35] },
  { name: 'Venus', hex: '#6ad500', rgb: [106, 213, 0] },
  { name: 'Azurite', hex: '#3867ae', rgb: [56, 103, 174] },
  { name: 'mClover3', hex: '#409945', rgb: [64, 153, 69] },
  { name: 'mJuniper', hex: '#1c978d', rgb: [28, 151, 141] },
  { name: 'mTurquoise2', hex: '#13AEA7', rgb: [19, 174, 167] },
  { name: 'Electra2', hex: '#1C58C6', rgb: [28, 88, 198] },
  { name: 'mWasabi', hex: '#009349', rgb: [0, 147, 73] },
  { name: 'mScarlet_I', hex: '#b9474b', rgb: [185, 71, 75] },
];

function colorDistance(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1-r2)**2 + (g1-g2)**2 + (b1-b2)**2);
}

function findClosestColor(r, g, b) {
  let minDist = Infinity;
  let closest = 0;
  for (let i = 0; i < PALETTE.length; i++) {
    const [pr, pg, pb] = PALETTE[i].rgb;
    const dist = colorDistance(r, g, b, pr, pg, pb);
    if (dist < minDist) {
      minDist = dist;
      closest = i;
    }
  }
  return closest;
}

function fetchImage(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      console.log('Fetch response:', res.statusCode, res.headers['content-type']);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const newUrl = res.headers.location.startsWith('http') 
          ? res.headers.location 
          : new URL(res.headers.location, url).href;
        return fetchImage(newUrl, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function generateImage(prompt) {
  const encodedPrompt = encodeURIComponent(prompt + ', pixel art style, simple shapes, bold colors');
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=512&seed=${Date.now()}&nologo=true`;
  console.log('Generating image from:', url);
  
  // Pollinations can take time to generate, retry a few times
  let lastError;
  for (let i = 0; i < 5; i++) {
    try {
      const imageBuffer = await fetchImage(url);
      console.log('Image buffer size:', imageBuffer.length, 'First bytes:', imageBuffer.slice(0, 20).toString('hex'));
      
      // Check if it starts with JPEG or PNG magic bytes
      const isJPEG = imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8;
      const isPNG = imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50;
      
      if (!isJPEG && !isPNG) {
        console.log('Not a valid image, retrying...');
        throw new Error('Invalid image format received');
      }
      
      // Convert to PNG to normalize
      const normalizedBuffer = await sharp(imageBuffer).png().toBuffer();
      const metadata = await sharp(normalizedBuffer).metadata();
      console.log('Image metadata:', metadata.format, metadata.width, 'x', metadata.height);
      return normalizedBuffer;
    } catch (err) {
      console.log('Attempt', i + 1, 'failed:', err.message);
      lastError = err;
      await new Promise(r => setTimeout(r, 5000)); // Wait 5s before retry
    }
  }
  throw lastError;
}

async function imageToGrid(imageBuffer) {
  const { data, info } = await sharp(imageBuffer)
    .resize(GRID_COLS, GRID_ROWS, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const grid = [];
  for (let y = 0; y < GRID_ROWS; y++) {
    const row = [];
    for (let x = 0; x < GRID_COLS; x++) {
      const idx = (y * GRID_COLS + x) * info.channels;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const colorIdx = findClosestColor(r, g, b);
      row.push(colorIdx);
    }
    grid.push(row);
  }
  return grid;
}

async function drawAndPublish(grid, title) {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  
  const page = await browser.newPage();
  
  try {
    await page.goto('https://ginkgoartworks.com/', { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    
    const cells = await page.$$('#grid-container input[type="checkbox"]');
    
    for (let colorIdx = 1; colorIdx < PALETTE.length; colorIdx++) {
      const pixels = [];
      for (let y = 0; y < GRID_ROWS; y++) {
        for (let x = 0; x < GRID_COLS; x++) {
          if (grid[y][x] === colorIdx) {
            pixels.push(y * GRID_COLS + x);
          }
        }
      }
      
      if (pixels.length === 0) continue;
      
      const colorSwatches = await page.$$('div[role="radio"]');
      if (colorSwatches[colorIdx]) {
        await colorSwatches[colorIdx].click();
        await new Promise(r => setTimeout(r, 100));
      }
      
      for (const idx of pixels) {
        const cell = cells[idx];
        if (cell) await cell.click();
      }
    }
    
    await new Promise(r => setTimeout(r, 500));
    
    const publishButtons = await page.$$('button');
    let publishBtn = null;
    let maxY = -1;
    for (const btn of publishButtons) {
      const text = await btn.evaluate(el => el.textContent);
      if (text.includes('Publish')) {
        const box = await btn.boundingBox();
        if (box && box.y > maxY) {
          maxY = box.y;
          publishBtn = btn;
        }
      }
    }
    
    if (!publishBtn) throw new Error('Publish button not found');
    await publishBtn.click();
    await new Promise(r => setTimeout(r, 1500));
    
    const titleInput = await page.$('input[type="text"]');
    if (titleInput && title) {
      await titleInput.click({ clickCount: 3 });
      await titleInput.type(title);
    }
    
    await new Promise(r => setTimeout(r, 500));
    
    const modalButtons = await page.$$('button');
    let modalPublishBtn = null;
    maxY = -1;
    for (const btn of modalButtons) {
      const text = await btn.evaluate(el => el.textContent);
      if (text.includes('Publish')) {
        const box = await btn.boundingBox();
        if (box && box.y > maxY) {
          maxY = box.y;
          modalPublishBtn = btn;
        }
      }
    }
    
    if (!modalPublishBtn) throw new Error('Modal publish button not found');
    await modalPublishBtn.click();
    await new Promise(r => setTimeout(r, 3000));
    
    const links = await page.$$('a');
    let galleryUrl = null;
    for (const link of links) {
      const href = await link.evaluate(el => el.href);
      if (href && href.includes('opentrons-art.rcdonovan.com')) {
        galleryUrl = href;
        break;
      }
    }
    
    await browser.close();
    return { success: true, url: galleryUrl };
    
  } catch (err) {
    await browser.close();
    throw err;
  }
}

const html = `<!DOCTYPE html>
<html>
<head>
  <title>Ginkgo AI Art</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 500px; 
      margin: 40px auto; 
      padding: 20px;
      background: #1a1a2e;
      color: #eee;
    }
    h1 { color: #00d4aa; margin-bottom: 10px; }
    .subtitle { color: #888; margin-bottom: 30px; font-size: 14px; }
    label { display: block; margin-bottom: 5px; color: #aaa; }
    input, textarea, button { 
      width: 100%; 
      padding: 12px; 
      margin-bottom: 15px; 
      border: 1px solid #333;
      border-radius: 8px;
      font-size: 16px;
    }
    input, textarea { background: #16213e; color: #eee; }
    input:focus, textarea:focus { outline: none; border-color: #00d4aa; }
    textarea { min-height: 80px; resize: vertical; }
    button { 
      background: #00d4aa; 
      color: #1a1a2e; 
      border: none; 
      cursor: pointer;
      font-weight: bold;
    }
    button:hover { background: #00b894; }
    button:disabled { background: #555; cursor: not-allowed; }
    #result { 
      margin-top: 20px; 
      padding: 15px; 
      border-radius: 8px;
      display: none;
    }
    #result.success { background: #0a3d2e; border: 1px solid #00d4aa; }
    #result.error { background: #3d0a0a; border: 1px solid #d44; }
    #result a { color: #00d4aa; word-break: break-all; }
    .spinner { display: none; margin: 10px auto; text-align: center; }
    .spinner.show { display: block; }
    .palette { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 20px; }
    .swatch { width: 24px; height: 24px; border-radius: 50%; border: 2px solid #333; }
  </style>
</head>
<body>
  <h1>🧬 Ginkgo AI Art</h1>
  <p class="subtitle">Text-to-bacteria art powered by AI</p>
  
  <div class="palette">
    <div class="swatch" style="background:#1fea5c" title="sfGFP"></div>
    <div class="swatch" style="background:#8f2438" title="mRFP1"></div>
    <div class="swatch" style="background:#b39223" title="mKO2"></div>
    <div class="swatch" style="background:#6ad500" title="Venus"></div>
    <div class="swatch" style="background:#3867ae" title="Azurite"></div>
    <div class="swatch" style="background:#409945" title="mClover3"></div>
    <div class="swatch" style="background:#1c978d" title="mJuniper"></div>
    <div class="swatch" style="background:#13AEA7" title="mTurquoise2"></div>
    <div class="swatch" style="background:#1C58C6" title="Electra2"></div>
    <div class="swatch" style="background:#009349" title="mWasabi"></div>
    <div class="swatch" style="background:#b9474b" title="mScarlet_I"></div>
  </div>
  
  <form id="form">
    <label>Describe your artwork</label>
    <textarea id="prompt" placeholder="A sunset over mountains, vibrant colors..." required></textarea>
    <label>Title (optional)</label>
    <input type="text" id="title" placeholder="My Artwork">
    <button type="submit" id="btn">🎨 Generate & Publish</button>
  </form>
  <div class="spinner" id="spinner">
    <p>⏳ Generating artwork...</p>
    <p style="font-size:12px;color:#888">This may take 30-60 seconds</p>
  </div>
  <div id="result"></div>
  
  <script>
    const form = document.getElementById('form');
    const btn = document.getElementById('btn');
    const spinner = document.getElementById('spinner');
    const result = document.getElementById('result');
    
    form.onsubmit = async (e) => {
      e.preventDefault();
      const prompt = document.getElementById('prompt').value;
      const title = document.getElementById('title').value;
      
      btn.disabled = true;
      spinner.classList.add('show');
      result.style.display = 'none';
      
      try {
        const res = await fetch('/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, title })
        });
        const data = await res.json();
        
        if (data.success) {
          result.className = 'success';
          result.innerHTML = '✅ Published!<br><a href="' + data.url + '" target="_blank">' + data.url + '</a>';
        } else {
          result.className = 'error';
          result.textContent = '❌ ' + data.error;
        }
      } catch (err) {
        result.className = 'error';
        result.textContent = '❌ ' + err.message;
      }
      
      result.style.display = 'block';
      spinner.classList.remove('show');
      btn.disabled = false;
    };
  </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(html));

app.post('/generate', async (req, res) => {
  const { prompt, title } = req.body;
  if (!prompt) return res.json({ success: false, error: 'Prompt required' });
  
  try {
    console.log('Generating image for:', prompt);
    const imageBuffer = await generateImage(prompt);
    console.log('Image generated, converting to grid...');
    const grid = await imageToGrid(imageBuffer);
    console.log('Grid created, drawing on canvas...');
    const result = await drawAndPublish(grid, title || prompt.slice(0, 50));
    console.log('Published:', result.url);
    res.json(result);
  } catch (err) {
    console.error('Error:', err);
    res.json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Ginkgo AI Art server running on port ${PORT}`);
});
