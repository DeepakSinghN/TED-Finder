import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import db, { initDatabase } from './db/index.js';
import { searchTalks, getRecentTalks, getActiveChannels } from './db/search.js';
import { createLearningPath, getLearningPathBySlug, toggleItemWatched } from './db/paths.js';
import { seedChannels } from './db/seedChannels.js';

// Initialize DB and ensure channels are seeded
initDatabase();
seedChannels();

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// CORS configuration (allow local dev & production domain)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:4321', 'http://127.0.0.1:4321', 'https://ted-finder.pages.dev', 'https://tedtalksfinder.com'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    return callback(new Error('Blocked by CORS policy'));
  }
}));

app.use(express.json({ limit: '1mb' }));

// -------------------------------------------------------------
// Bounded In-Memory LRU Cache with TTL (Fixes Memory Leak Loophole)
// -------------------------------------------------------------
const MAX_CACHE_ITEMS = 200;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const queryCache = new Map();

function getCached(key) {
  const item = queryCache.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL_MS) {
    queryCache.delete(key);
    return null;
  }
  return item.data;
}

function setCached(key, data) {
  if (queryCache.size >= MAX_CACHE_ITEMS) {
    const oldestKey = queryCache.keys().next().value;
    queryCache.delete(oldestKey);
  }
  queryCache.set(key, { data, timestamp: Date.now() });
}

// -------------------------------------------------------------
// Rate Limiters
// -------------------------------------------------------------
const searchLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 100, // Generous limit for DB search
  message: {
    error: "Daily search limit reached. Please try again tomorrow."
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Max 5 messages per hour per IP (Fixes spam loophole)
  message: {
    error: "Too many contact submissions from this IP. Please wait an hour before submitting again."
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// 1. GET /api/channels — List active channels for filter pills
app.get('/api/channels', (req, res) => {
  try {
    const channels = getActiveChannels();
    return res.json({ channels });
  } catch (err) {
    console.error('Error fetching channels:', err);
    return res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// 2. GET /api/search — Layer A: Super-Fast Multi-Channel DB Search
app.get('/api/search', searchLimiter, (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const channel = (req.query.channel || '').toString().trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 12, 50);
  const offset = parseInt(req.query.offset, 10) || 0;

  // Validate length (Fixes payload injection loophole)
  if (q.length > 100) {
    return res.status(400).json({ error: 'Search query too long (max 100 characters).' });
  }

  const cacheKey = `search:${q.toLowerCase()}:${channel}:${limit}:${offset}`;
  const cachedData = getCached(cacheKey);
  if (cachedData) {
    return res.json(cachedData);
  }

  try {
    const results = searchTalks({ query: q, channelId: channel, limit, offset });
    const responseData = {
      query: q,
      channel: channel || 'all',
      total: results.length,
      results
    };

    setCached(cacheKey, responseData);
    return res.json(responseData);
  } catch (err) {
    console.error('[Search API Error]:', err);
    return res.status(500).json({ error: 'Failed to search talks from database' });
  }
});

// 3. GET /api/recent and GET /api/recent-uploads — Latest Talks Feed
const handleRecent = (req, res) => {
  const channel = (req.query.channel || '').toString().trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 6, 20);

  const cacheKey = `recent:${channel}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    const results = getRecentTalks({ channelId: channel, limit });
    const responseData = { results };
    setCached(cacheKey, responseData);
    return res.json(responseData);
  } catch (err) {
    console.error('[Recent API Error]:', err);
    return res.status(500).json({ error: 'Failed to load recent talks' });
  }
};

app.get('/api/recent', handleRecent);
app.get('/api/recent-uploads', handleRecent);

// 4. POST /api/find-talks — Backward Compatible Endpoint for Frontend
app.post('/api/find-talks', searchLimiter, (req, res) => {
  const { topic } = req.body;
  if (!topic || typeof topic !== 'string' || topic.trim() === '') {
    return res.status(400).json({ error: "A search topic is required." });
  }

  const cleanTopic = topic.trim().slice(0, 100);
  const cacheKey = `find-talks:${cleanTopic.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // 1. Search DB for curated talks matching topic
    const results = searchTalks({ query: cleanTopic, limit: 12 });
    // 2. Get recent talks
    const recentResults = getRecentTalks({ limit: 4 });

    const payload = {
      topic: cleanTopic,
      results,
      recentResults
    };

    setCached(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    console.error('[Find-Talks Error]:', err);
    return res.status(500).json({ error: 'Failed to retrieve talks.' });
  }
});

// 5. POST /api/paths — Generate an AI Learning Path from user goal
app.post('/api/paths', searchLimiter, async (req, res) => {
  const { goal, userId } = req.body;
  if (!goal || typeof goal !== 'string' || goal.trim() === '') {
    return res.status(400).json({ error: 'Please enter a goal or topic for your learning path.' });
  }

  const cleanGoal = goal.trim().slice(0, 200);

  try {
    const path = await createLearningPath({ goal: cleanGoal, userId: userId || null });
    return res.json({ success: true, path });
  } catch (err) {
    console.error('[Paths API Error]:', err);
    return res.status(500).json({ error: err.message || 'Failed to create learning path.' });
  }
});

// 6. GET /api/paths/:slug — Retrieve a learning path by its shareable slug
app.get('/api/paths/:slug', (req, res) => {
  const { slug } = req.params;
  if (!slug) {
    return res.status(400).json({ error: 'Path slug is required.' });
  }

  try {
    const path = getLearningPathBySlug(slug.trim());
    if (!path) {
      return res.status(404).json({ error: 'Learning path not found.' });
    }
    return res.json({ success: true, path });
  } catch (err) {
    console.error('[Get Path Error]:', err);
    return res.status(500).json({ error: 'Failed to retrieve path.' });
  }
});

// 7. PATCH /api/paths/:slug/items/:itemId — Mark talk as watched / unwatched
app.patch('/api/paths/:slug/items/:itemId', (req, res) => {
  const { itemId } = req.params;
  const { isWatched } = req.body;

  try {
    const success = toggleItemWatched(itemId, Boolean(isWatched));
    if (!success) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    return res.json({ success: true, itemId, isWatched: Boolean(isWatched) });
  } catch (err) {
    console.error('[Update Item Error]:', err);
    return res.status(500).json({ error: 'Failed to update item.' });
  }
});

// 8. POST /api/contact — Contact Form with Rate Limiter & Resend Delivery
app.post('/api/contact', contactLimiter, async (req, res) => {
  const { name, email, subject, message } = req.body;

  if (!name || !name.trim() || !email || !email.trim() || !subject || !subject.trim() || !message || !message.trim()) {
    return res.status(400).json({ error: "All fields are required and cannot be blank." });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  console.log("==========================================");
  console.log("NEW CONTACT FORM SUBMISSION RECEIVED:");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Name: ${name}`);
  console.log(`Email: ${email}`);
  console.log(`Subject: ${subject}`);
  console.log(`Message:\n${message}`);
  console.log("==========================================");

  // Send email via Resend if API Key is configured
  const resendApiKey = process.env.RESEND_API_KEY;
  const notificationEmail = process.env.NOTIFICATION_EMAIL;

  if (resendApiKey && !resendApiKey.toUpperCase().includes("YOUR_") && resendApiKey.trim() !== "") {
    const toEmail = notificationEmail && !notificationEmail.includes("your_email") 
      ? notificationEmail.trim() 
      : "delivered@resend.dev";

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendApiKey.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "TED Talk Finder <onboarding@resend.dev>",
          to: toEmail,
          subject: `[Talk Finder 2.0] New Contact: ${subject}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 5px;">
              <h2 style="color: #EB0028; border-bottom: 2px solid #EB0028; padding-bottom: 10px; text-transform: uppercase; font-size: 18px;">
                New Contact Form Submission
              </h2>
              <p style="margin: 15px 0;"><strong>Name:</strong> ${name}</p>
              <p style="margin: 15px 0;"><strong>Email:</strong> <a href="mailto:${email}" style="color: #EB0028;">${email}</a></p>
              <p style="margin: 15px 0;"><strong>Subject:</strong> ${subject}</p>
              <p style="margin: 15px 0; font-weight: bold;">Message:</p>
              <div style="white-space: pre-wrap; background: #f9f9f9; padding: 15px; border-left: 4px solid #EB0028; font-size: 14px; color: #333; line-height: 1.5;">${message}</div>
            </div>
          `
        })
      });

      if (!response.ok) {
        const resData = await response.json();
        console.error("Resend API error:", resData);
        return res.status(502).json({ error: "Failed to transmit email through Resend." });
      }
    } catch (emailError) {
      console.error("Failed to transmit email through Resend API:", emailError);
      return res.status(502).json({ error: "Failed to transmit email through Resend." });
    }
  }

  return res.json({ success: true, message: "Your message has been received. Thank you!" });
});

// Start the server
app.listen(PORT, () => {
  console.log(`[Talk Finder 2.0 Backend] Server running on http://localhost:${PORT}`);
  console.log(`[Talk Finder 2.0 Backend] Ready with SQLite DB, FTS5 Search, and LRU Cache.`);
});
