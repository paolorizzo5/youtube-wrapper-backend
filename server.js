const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const YouTube = require('youtube-sr').default;

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

function isQuotaError(err) {
  const reason = err.response?.data?.error?.errors?.[0]?.reason;
  return reason === 'quotaExceeded' || reason === 'dailyLimitExceeded';
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code));
}

// Write cookies to temp file if env var is set
let COOKIES_FILE = null;
if (process.env.YOUTUBE_COOKIES_B64) {
  COOKIES_FILE = path.join(os.tmpdir(), 'yt_cookies.txt');
  const decoded = Buffer.from(process.env.YOUTUBE_COOKIES_B64, 'base64');
  fs.writeFileSync(COOKIES_FILE, decoded);
  console.log(`Cookies file written: ${COOKIES_FILE} (${decoded.toString().split('\n').length} lines)`);
}

// Search videos using YouTube Data API v3, fallback to youtube-sr on quota exhaustion
app.get('/search', async (req, res) => {
  const { q, pageToken } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  // Try YouTube Data API first
  try {
    const response = await axios.get(`${YOUTUBE_API_BASE}/search`, {
      params: {
        key: YOUTUBE_API_KEY,
        q,
        part: 'snippet',
        type: 'video',
        maxResults: 20,
        videoCategoryId: '10',
        pageToken: pageToken || undefined,
      },
    });

    const items = response.data.items.map((item) => ({
      videoId: item.id.videoId,
      title: decodeHtml(item.snippet.title),
      channel: decodeHtml(item.snippet.channelTitle),
      thumbnail: item.snippet.thumbnails.medium.url,
      publishedAt: item.snippet.publishedAt,
    }));

    return res.json({ items, nextPageToken: response.data.nextPageToken || null });
  } catch (err) {
    if (!isQuotaError(err)) {
      console.error('Search error:', err.response?.data || err.message);
      return res.status(500).json({ error: 'Search failed' });
    }
    console.warn('YouTube API quota exceeded — falling back to youtube-sr');
  }

  // Fallback: youtube-sr (no API key needed, pagination not supported so pageToken is ignored)
  try {
    const results = await YouTube.search(q, { limit: 20, type: 'video', safeSearch: false });
    const items = results.map((v) => ({
      videoId: v.id,
      title: v.title || '',
      channel: v.channel?.name || '',
      thumbnail: v.thumbnail?.url || '',
      publishedAt: null,
    }));
    return res.json({ items, nextPageToken: null, source: 'fallback' });
  } catch (fallbackErr) {
    console.error('Fallback search error:', fallbackErr.message);
    return res.status(503).json({ error: 'Search unavailable: quota exceeded and fallback failed' });
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
      title: decodeHtml(item.snippet.title),
      channel: decodeHtml(item.snippet.channelTitle),
      thumbnail: item.snippet.thumbnails.medium.url,
      duration: item.contentDetails.duration,
    });
  } catch (err) {
    console.error('Video details error:', err.message);
    res.status(500).json({ error: 'Failed to get video details' });
  }
});

// Get related videos based on a videoId
app.get('/related', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

  let searchQuery = null;

  // Try to get video title from YouTube Data API
  try {
    const videoRes = await axios.get(`${YOUTUBE_API_BASE}/videos`, {
      params: { key: YOUTUBE_API_KEY, id: videoId, part: 'snippet' },
    });
    const video = videoRes.data.items[0];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    searchQuery = `${video.snippet.title} ${video.snippet.channelTitle}`;

    const searchRes = await axios.get(`${YOUTUBE_API_BASE}/search`, {
      params: {
        key: YOUTUBE_API_KEY,
        q: searchQuery,
        part: 'snippet',
        type: 'video',
        maxResults: 11,
        videoCategoryId: '10',
      },
    });

    const items = searchRes.data.items
      .filter((item) => item.id.videoId !== videoId)
      .slice(0, 10)
      .map((item) => ({
        videoId: item.id.videoId,
        title: decodeHtml(item.snippet.title),
        channel: decodeHtml(item.snippet.channelTitle),
        thumbnail: item.snippet.thumbnails.medium.url,
      }));

    return res.json({ items });
  } catch (err) {
    if (!isQuotaError(err)) {
      console.error('Related error:', err.response?.data || err.message);
      return res.status(500).json({ error: 'Failed to get related videos' });
    }
    console.warn('YouTube API quota exceeded — falling back to youtube-sr for related');
  }

  // Fallback: use yt-dlp to get the title if we don't have it yet, then search via youtube-sr
  try {
    if (!searchQuery) {
      // Get title directly from the video page via yt-dlp --dump-json
      searchQuery = await new Promise((resolve, reject) => {
        exec(
          `yt-dlp --js-runtimes node --no-playlist --dump-json "https://www.youtube.com/watch?v=${videoId}"`,
          { timeout: 15000 },
          (err, stdout) => {
            if (err) return reject(err);
            try {
              const info = JSON.parse(stdout.trim());
              resolve(`${info.title} ${info.uploader || ''}`);
            } catch { reject(new Error('Failed to parse yt-dlp output')); }
          }
        );
      });
    }

    const results = await YouTube.search(searchQuery, { limit: 11, type: 'video', safeSearch: false });
    const items = results
      .filter((v) => v.id !== videoId)
      .slice(0, 10)
      .map((v) => ({
        videoId: v.id,
        title: v.title || '',
        channel: v.channel?.name || '',
        thumbnail: v.thumbnail?.url || '',
      }));

    return res.json({ items, source: 'fallback' });
  } catch (fallbackErr) {
    console.error('Related fallback error:', fallbackErr.message);
    return res.status(503).json({ error: 'Related unavailable: quota exceeded and fallback failed' });
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
