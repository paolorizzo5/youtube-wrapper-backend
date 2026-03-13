const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

// ── Playlist persistence ──────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readPlaylists() {
  try {
    return JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writePlaylists(data) {
  fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(data), 'utf8');
}

// GET /playlists
app.get('/playlists', (req, res) => {
  res.json(readPlaylists());
});

// POST /playlists  { name }
app.post('/playlists', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const all = readPlaylists();
  const playlist = { id: Date.now().toString(), name, tracks: [] };
  writePlaylists([...all, playlist]);
  res.json(playlist);
});

// DELETE /playlists/:id
app.delete('/playlists/:id', (req, res) => {
  const all = readPlaylists();
  writePlaylists(all.filter((p) => p.id !== req.params.id));
  res.json({ ok: true });
});

// POST /playlists/:id/tracks  { videoId, title, channel, thumbnail }
app.post('/playlists/:id/tracks', (req, res) => {
  const all = readPlaylists();
  const p = all.find((p) => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Playlist not found' });
  if (!p.tracks.find((t) => t.videoId === req.body.videoId)) {
    p.tracks.push(req.body);
    writePlaylists(all);
  }
  res.json(p);
});

// DELETE /playlists/:id/tracks/:videoId
app.delete('/playlists/:id/tracks/:videoId', (req, res) => {
  const all = readPlaylists();
  const p = all.find((p) => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Playlist not found' });
  p.tracks = p.tracks.filter((t) => t.videoId !== req.params.videoId);
  writePlaylists(all);
  res.json(p);
});

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// Write cookies to temp file if env var is set
let COOKIES_FILE = null;
if (process.env.YOUTUBE_COOKIES_B64) {
  COOKIES_FILE = path.join(os.tmpdir(), 'yt_cookies.txt');
  const decoded = Buffer.from(process.env.YOUTUBE_COOKIES_B64, 'base64');
  fs.writeFileSync(COOKIES_FILE, decoded);
  console.log(`Cookies file written: ${COOKIES_FILE} (${decoded.toString().split('\n').length} lines)`);
}

// Search videos using YouTube Data API v3
app.get('/search', async (req, res) => {
  const { q, pageToken } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  try {
    const response = await axios.get(`${YOUTUBE_API_BASE}/search`, {
      params: {
        key: YOUTUBE_API_KEY,
        q,
        part: 'snippet',
        type: 'video',
        maxResults: 20,
        videoCategoryId: '10', // Music category
        pageToken: pageToken || undefined,
      },
    });

    const items = response.data.items.map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.medium.url,
      publishedAt: item.snippet.publishedAt,
    }));

    res.json({
      items,
      nextPageToken: response.data.nextPageToken || null,
    });
  } catch (err) {
    console.error('Search error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get video details (duration, etc.)
app.get('/video/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const response = await axios.get(`${YOUTUBE_API_BASE}/videos`, {
      params: {
        key: YOUTUBE_API_KEY,
        id: videoId,
        part: 'snippet,contentDetails',
      },
    });
    const item = response.data.items[0];
    if (!item) return res.status(404).json({ error: 'Video not found' });

    res.json({
      videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.medium.url,
      duration: item.contentDetails.duration,
    });
  } catch (err) {
    console.error('Video details error:', err.message);
    res.status(500).json({ error: 'Failed to get video details' });
  }
});

// Extract audio stream URL using yt-dlp
app.get('/stream', (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Get the best audio-only stream URL
  const cookiesArg = COOKIES_FILE ? `--cookies "${COOKIES_FILE}"` : '';
  exec(
    `yt-dlp --js-runtimes node ${cookiesArg} -f bestaudio --get-url "${url}"`,
    { timeout: 15000 },
    (error, stdout, stderr) => {
      if (error) {
        console.error('yt-dlp error:', stderr);
        return res.status(500).json({ error: 'Failed to extract stream URL' });
      }
      const streamUrl = stdout.trim().split('\n')[0];
      res.json({ streamUrl });
    }
  );
});

// Proxy audio stream (optional, for clients that can't access the direct URL)
app.get('/proxy', (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const ytdlpArgs = ['--js-runtimes', 'node'];
  if (COOKIES_FILE) ytdlpArgs.push('--cookies', COOKIES_FILE);
  ytdlpArgs.push('-f', 'bestaudio', '-o', '-', '--quiet', url);

  const ytdlp = spawn('yt-dlp', ytdlpArgs);

  res.setHeader('Content-Type', 'audio/webm');
  res.setHeader('Transfer-Encoding', 'chunked');

  ytdlp.stdout.pipe(res);

  ytdlp.stderr.on('data', (data) => console.error('yt-dlp stderr:', data.toString()));

  ytdlp.on('close', (code) => {
    if (code !== 0) console.error(`yt-dlp exited with code ${code}`);
  });

  req.on('close', () => ytdlp.kill());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
