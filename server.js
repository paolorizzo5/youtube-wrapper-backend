const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const axios = require('axios');

const app = express();
app.use(cors());

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

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
  exec(
    `yt-dlp -f bestaudio --get-url "${url}"`,
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

  const ytdlp = spawn('yt-dlp', [
    '-f', 'bestaudio',
    '-o', '-',
    '--quiet',
    url,
  ]);

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
