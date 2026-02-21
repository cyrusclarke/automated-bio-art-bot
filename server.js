const express = require('express');
const puppeteer = require('puppeteer-core');
const sharp = require('sharp');
const https = require('https');
const http = require('http');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const GRID_COLS = 48;
const GRID_ROWS = 32;

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

// Job storage
const jobs = new Map();

function colorDistance(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1-r2)**2 + (g1-g2)**2 + (b1-b2)**2);
}

function findClosestColor(r, g, b) {
  let minDist = Infinity;
  let closest = 0;
  for (let i = 0; i < PALETTE.length; i++) {
    const [pr, pg, pb] = PALETTE[i].rgb;
    const dist = colorDistance(r, g, b, pr, pg, pb);
    if (dist < minDist) { minDist = dist; closest = i; }
  }
  return closest;
}

function fetchImage(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const newUrl = res.headers.location.startsWith('http') 
          ? res.headers.location : new URL(res.headers.location, url).href;
        return fetchImage(newUrl, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function generateImage(prompt) {
  console.log('Generating with DALL-E:', prompt);
  
  // Our palette colors described for DALL-E
  const colorGuide = `
Use ONLY these specific colors:
- Bright neon green (#1fea5c)
- Dark maroon red (#8f2438) 
- Golden ochre (#b39223)
- Lime yellow-green (#6ad500)
- Medium blue (#3867ae)
- Forest green (#409945)
- Teal (#1c978d)
- Cyan/turquoise (#13AEA7)
- Royal blue (#1C58C6)
- Emerald green (#009349)
- Coral red (#b9474b)
- White background`;

  const enhancedPrompt = `Create a very simple, minimalist pixel art icon of: ${prompt}

Requirements:
- Centered subject filling most of the frame
- Pure white (#ffffff) background, NO shadows or gradients
- Extremely simple shapes, like a 16x16 pixel sprite scaled up
- Flat colors only, no shading or anti-aliasing
- Bold black outlines optional
- Maximum 4-5 colors total
${colorGuide}

Style: 8-bit retro pixel art, NES-era simplicity, chunky pixels, iconic and immediately recognizable`;

  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: enhancedPrompt,
      n: 1,
      size: "1024x1024",
      quality: "standard",
    });
    
    const imageUrl = response.data[0].url;
    console.log('DALL-E URL:', imageUrl);
    
    const buf = await fetchImage(imageUrl);
    return await sharp(buf).png().toBuffer();
  } catch (err) {
    console.error('DALL-E error:', err.message);
    throw err;
  }
}

async function imageToGrid(imageBuffer) {
  // First resize with high quality, then quantize
  const { data, info } = await sharp(imageBuffer)
    .resize(GRID_COLS, GRID_ROWS, { 
      fit: 'fill',
      kernel: 'lanczos3'  // High quality downscaling
    })
    .median(1)  // Slight smoothing to reduce noise
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const grid = [];
  for (let y = 0; y < GRID_ROWS; y++) {
    const row = [];
    for (let x = 0; x < GRID_COLS; x++) {
      const idx = (y * GRID_COLS + x) * info.channels;
      const r = data[idx], g = data[idx+1], b = data[idx+2];
      
      // If very light, make it white (background)
      if (r > 240 && g > 240 && b > 240) {
        row.push(0); // erase/white
      } else {
        row.push(findClosestColor(r, g, b));
      }
    }
    grid.push(row);
  }
  return grid;
}

function gridToSvg(grid) {
  const cellSize = 10;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${GRID_COLS*cellSize}" height="${GRID_ROWS*cellSize}">`;
  for (let y = 0; y < GRID_ROWS; y++) {
    for (let x = 0; x < GRID_COLS; x++) {
      const color = PALETTE[grid[y][x]].hex;
      svg += `<rect x="${x*cellSize}" y="${y*cellSize}" width="${cellSize}" height="${cellSize}" fill="${color}"/>`;
    }
  }
  svg += '</svg>';
  return svg;
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
          if (grid[y][x] === colorIdx) pixels.push(y * GRID_COLS + x);
        }
      }
      if (pixels.length === 0) continue;
      
      const swatches = await page.$$('div[role="radio"]');
      if (swatches[colorIdx]) {
        await swatches[colorIdx].click();
        await new Promise(r => setTimeout(r, 50));
      }
      for (const idx of pixels) {
        if (cells[idx]) await cells[idx].click();
      }
    }
    
    await new Promise(r => setTimeout(r, 500));
    let btns = await page.$$('button');
    for (const btn of btns) {
      const txt = await btn.evaluate(el => el.textContent);
      if (txt.includes('Publish')) { await btn.click(); break; }
    }
    
    await new Promise(r => setTimeout(r, 1500));
    const titleInput = await page.$('input[type="text"]');
    if (titleInput && title) {
      await titleInput.click({ clickCount: 3 });
      await titleInput.type(title);
    }
    
    await new Promise(r => setTimeout(r, 500));
    btns = await page.$$('button');
    for (const btn of btns) {
      const txt = await btn.evaluate(el => el.textContent);
      if (txt.includes('Publish')) { await btn.click(); break; }
    }
    
    await new Promise(r => setTimeout(r, 3000));
    const links = await page.$$('a');
    let url = null;
    for (const link of links) {
      const href = await link.evaluate(el => el.href);
      if (href && href.includes('opentrons-art')) { url = href; break; }
    }
    
    await browser.close();
    return { success: true, url };
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
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; background: #1a1a2e; color: #eee; }
    h1 { color: #00d4aa; }
    .sub { color: #888; margin-bottom: 20px; }
    label { display: block; margin: 10px 0 5px; color: #aaa; }
    input, textarea, button { width: 100%; padding: 12px; margin-bottom: 10px; border: 1px solid #333; border-radius: 8px; font-size: 16px; }
    input, textarea { background: #16213e; color: #eee; }
    textarea { min-height: 80px; }
    button { background: #00d4aa; color: #1a1a2e; border: none; cursor: pointer; font-weight: bold; }
    button:hover { background: #00b894; }
    button:disabled { background: #555; }
    #preview { margin: 20px 0; text-align: center; }
    #preview svg { max-width: 100%; border: 1px solid #333; }
    #status { padding: 15px; border-radius: 8px; margin: 10px 0; }
    .success { background: #0a3d2e; border: 1px solid #00d4aa; }
    .error { background: #3d0a0a; border: 1px solid #d44; }
    .pending { background: #2e2a0a; border: 1px solid #d4a700; }
    a { color: #00d4aa; word-break: break-all; }
    .palette { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 15px; }
    .swatch { width: 20px; height: 20px; border-radius: 50%; border: 2px solid #333; }
  </style>
</head>
<body>
  <h1>🧬 Ginkgo AI Art</h1>
  <p class="sub">AI-powered bacteria art</p>
  <div class="palette">
    ${PALETTE.slice(1).map(c => '<div class="swatch" style="background:'+c.hex+'" title="'+c.name+'"></div>').join('')}
  </div>
  
  <label>Describe your artwork</label>
  <textarea id="prompt" placeholder="A sunset over mountains..."></textarea>
  <label>Title</label>
  <input id="title" placeholder="My Artwork">
  <button id="genBtn">🎨 Generate Preview</button>
  <div id="preview"></div>
  <button id="pubBtn" style="display:none">🚀 Publish to Ginkgo</button>
  <div id="status"></div>
  
  <script>
    let currentJobId = null;
    const genBtn = document.getElementById('genBtn');
    const pubBtn = document.getElementById('pubBtn');
    const preview = document.getElementById('preview');
    const status = document.getElementById('status');
    
    genBtn.onclick = async () => {
      const prompt = document.getElementById('prompt').value;
      if (!prompt) return alert('Enter a prompt');
      genBtn.disabled = true;
      status.className = 'pending';
      status.textContent = '⏳ Generating preview...';
      preview.innerHTML = '';
      pubBtn.style.display = 'none';
      
      try {
        const res = await fetch('/preview', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ prompt })
        });
        const data = await res.json();
        if (data.svg) {
          preview.innerHTML = data.svg;
          currentJobId = data.jobId;
          pubBtn.style.display = 'block';
          status.className = 'success';
          status.textContent = '✅ Preview ready! Click Publish to send to Ginkgo.';
        } else {
          status.className = 'error';
          status.textContent = '❌ ' + (data.error || 'Failed');
        }
      } catch (e) {
        status.className = 'error';
        status.textContent = '❌ ' + e.message;
      }
      genBtn.disabled = false;
    };
    
    pubBtn.onclick = async () => {
      if (!currentJobId) return;
      const title = document.getElementById('title').value || document.getElementById('prompt').value.slice(0,50);
      pubBtn.disabled = true;
      status.className = 'pending';
      status.textContent = '⏳ Publishing to Ginkgo (this takes ~60s)...';
      
      try {
        const res = await fetch('/publish', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ jobId: currentJobId, title })
        });
        const data = await res.json();
        if (data.success) {
          status.className = 'success';
          status.innerHTML = '✅ Published! <a href="'+data.url+'" target="_blank">'+data.url+'</a>';
        } else if (data.status === 'processing') {
          pollStatus(currentJobId);
        } else {
          status.className = 'error';
          status.textContent = '❌ ' + (data.error || 'Failed');
        }
      } catch (e) {
        status.className = 'error';
        status.textContent = '❌ ' + e.message;
      }
      pubBtn.disabled = false;
    };
    
    async function pollStatus(jobId) {
      const res = await fetch('/status/' + jobId);
      const data = await res.json();
      if (data.status === 'done') {
        status.className = 'success';
        status.innerHTML = '✅ Published! <a href="'+data.url+'" target="_blank">'+data.url+'</a>';
      } else if (data.status === 'error') {
        status.className = 'error';
        status.textContent = '❌ ' + data.error;
      } else {
        setTimeout(() => pollStatus(jobId), 3000);
      }
    }
  </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(html));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/preview', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.json({ error: 'Prompt required' });
    
    console.log('Generating preview for:', prompt);
    const imageBuffer = await generateImage(prompt);
    const grid = await imageToGrid(imageBuffer);
    const svg = gridToSvg(grid);
    
    const jobId = Date.now().toString(36);
    jobs.set(jobId, { grid, status: 'preview' });
    
    // Clean old jobs
    for (const [id, job] of jobs) {
      if (Date.now() - parseInt(id, 36) > 3600000) jobs.delete(id);
    }
    
    res.json({ svg, jobId });
  } catch (err) {
    console.error('Preview error:', err);
    res.json({ error: err.message });
  }
});

app.post('/publish', async (req, res) => {
  try {
    const { jobId, title } = req.body;
    const job = jobs.get(jobId);
    if (!job) return res.json({ error: 'Job not found' });
    
    job.status = 'processing';
    res.json({ status: 'processing' });
    
    // Process in background
    drawAndPublish(job.grid, title).then(result => {
      job.status = 'done';
      job.url = result.url;
    }).catch(err => {
      job.status = 'error';
      job.error = err.message;
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.json({ error: 'Job not found' });
  res.json({ status: job.status, url: job.url, error: job.error });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server on port ${PORT}`));
