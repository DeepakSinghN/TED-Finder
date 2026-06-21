import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const isPlaceholder = (key) => !key || key.toUpperCase().includes("YOUR_") || key.trim() === "" || key.includes("api_key");

// Parse Gemini Keys list
const geminiKeys = (process.env.GEMINI_API_KEYS
  ? process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
  : (process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY.trim()] : []))
  .filter(k => !isPlaceholder(k));

// Parse YouTube Keys list
const youtubeKeys = (process.env.YOUTUBE_API_KEYS
  ? process.env.YOUTUBE_API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
  : (process.env.YOUTUBE_API_KEY ? [process.env.YOUTUBE_API_KEY.trim()] : []))
  .filter(k => !isPlaceholder(k));

// Parse Grok Keys list
const grokKeys = (process.env.GROK_API_KEYS
  ? process.env.GROK_API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
  : (process.env.GROK_API_KEY ? [process.env.GROK_API_KEY.trim()] : []))
  .filter(k => !isPlaceholder(k));

console.log(`Configured Gemini API Keys: ${geminiKeys.length}`);
console.log(`Configured YouTube API Keys: ${youtubeKeys.length}`);
console.log(`Configured Grok API Keys: ${grokKeys.length}`);

// Enable CORS for frontend requests
app.use(cors());
app.use(express.json());

// IP-based rate limiter: Max 20 requests per day per IP
const limiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 20,
  message: {
    error: "Daily search limit reached. You can only perform 20 searches per day to help manage API quotas."
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiter to the find-talks endpoint
app.use('/api/find-talks', limiter);

// Helper function to parse ISO 8601 YouTube video duration (e.g., PT14M24S)
function parseDuration(durationStr) {
  if (!durationStr) return "N/A";

  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
  const match = durationStr.match(regex);
  if (!match) return "N/A";

  const hours = match[1] ? parseInt(match[1]) : 0;
  const minutes = match[2] ? parseInt(match[2]) : 0;
  const seconds = match[3] ? parseInt(match[3]) : 0;

  if (hours > 0) {
    return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
  }
  if (minutes > 0) {
    return `${minutes} min`;
  }
  if (seconds > 0) {
    return `${seconds} sec`;
  }
  return "0 min";
}

// Helper function to calculate duration in seconds for filtering out YouTube Shorts
function getDurationSeconds(durationStr) {
  if (!durationStr) return 0;
  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
  const match = durationStr.match(regex);
  if (!match) return 0;

  const hours = match[1] ? parseInt(match[1]) : 0;
  const minutes = match[2] ? parseInt(match[2]) : 0;
  const seconds = match[3] ? parseInt(match[3]) : 0;

  return (hours * 3600) + (minutes * 60) + seconds;
}

// Helper function to split raw titles from official TED channel
function parseTedTitle(rawTitle) {
  if (!rawTitle) return { speaker: "TED Speaker", title: "" };

  // Decode standard HTML entities
  let clean = rawTitle
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  // Strip trailing " | TED" or " | TEDx" variants
  clean = clean.replace(/\s*\|\s*TEDx?(Talks)?\s*$/i, '').trim();

  // 1. Try split by colon (common: "Speaker Name: Title of Talk")
  const colonIndex = clean.indexOf(':');
  if (colonIndex > 0 && colonIndex < 35) {
    const speaker = clean.substring(0, colonIndex).trim();
    const title = clean.substring(colonIndex + 1).trim();
    return { speaker, title };
  }

  // 2. Try split by vertical bar or dash
  const splitters = [' | ', ' - '];
  for (const splitter of splitters) {
    const parts = clean.split(splitter);
    if (parts.length === 2) {
      return { speaker: parts[1].trim(), title: parts[0].trim() };
    }
  }

  // Fallback
  return { speaker: "TED Speaker", title: clean };
}

// Grade search matches to filter out loosely related results
function getRelevanceScore(title, description, keyword) {
  const t = (title || "").toLowerCase();
  const d = (description || "").toLowerCase();
  const kw = keyword.toLowerCase();

  // Exact phrase match in title
  if (t.includes(kw)) return 3;

  // Split multi-word keywords
  const kwWords = kw.split(/\s+/).filter(Boolean);
  if (kwWords.length > 1) {
    // All words of keyword present in title
    const allInTitle = kwWords.every(word => t.includes(word));
    if (allInTitle) return 2;
  }

  // Exact phrase match in description
  if (d.includes(kw)) return 1;

  // Any word of keyword present in title
  const anyInTitle = kwWords.some(word => t.includes(word));
  if (anyInTitle) return 0.5;

  return 0; // Irrelevant
}

// Call AI Model to generate initial list of TED Talks
async function getAISuggestions(topic) {
  const prompt = `List 12 real, long-form TED talks where the title or core topic is SPECIFICALLY about "${topic}" — not tangentially related.
Provide a balanced mix of well-known classics and recent talks (released in the last 2-3 years).
Do not include talks about broader or different topics unless "${topic}" is a major focus of that talk.
If you cannot find 12 strong matches, return fewer — do not pad with loosely related talks.
For each suggestion, give: speaker full name, exact title, a one-sentence reason it's relevant, and the approximate year it was published.
Only suggest items you are confident actually exist.
Respond ONLY in this JSON format:
[
  { "speaker": "...", "title": "...", "reason": "...", "year": 2018 }
]`;

  if (geminiKeys.length === 0 && grokKeys.length === 0) {
    throw new Error("No AI API keys configured. Please add GEMINI_API_KEYS or GROK_API_KEYS to your .env file.");
  }

  let lastError;

  // 1. Try Gemini keys first
  for (let i = 0; i < geminiKeys.length; i++) {
    const key = geminiKeys[i];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
    console.log(`Attempting Gemini API request with Key #${i + 1}...`);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });
      
      if (!response.ok) {
        const errText = await response.text();
        const status = response.status;
        console.error(`Gemini API key #${i + 1} failed with status ${status}: ${errText}`);
        
        if (status === 429 || status === 403 || status === 503 || status === 504 || status === 400) {
          lastError = new Error(`Gemini API Error (status ${status}): ${errText}`);
          continue;
        }
        throw new Error(`Gemini API error (${status}): ${errText}`);
      }
      
      const data = await response.json();
      let text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      if (text.startsWith("```")) {
        text = text.replace(/^```json\s*/, "").replace(/```$/, "").trim();
      }
      return JSON.parse(text);
    } catch (err) {
      console.error(`Gemini Key #${i + 1} request threw error:`, err.message);
      lastError = err;
    }
  }

  // 2. Try Grok keys as fallback
  for (let i = 0; i < grokKeys.length; i++) {
    const key = grokKeys[i];
    const url = 'https://api.xai.com/v1/chat/completions';
    console.log(`Attempting Grok API request with Key #${i + 1}...`);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
          model: 'grok-2',
          messages: [
            { role: 'system', content: 'You are a helpful assistant. You must ONLY output JSON. Never write conversational intro or outro text.' },
            { role: 'user', content: prompt }
          ]
        })
      });
      
      if (!response.ok) {
        const errText = await response.text();
        const status = response.status;
        console.error(`Grok API key #${i + 1} failed with status ${status}: ${errText}`);
        
        if (status === 429 || status === 403 || status === 503 || status === 504 || status === 400) {
          lastError = new Error(`Grok API Error (status ${status}): ${errText}`);
          continue;
        }
        throw new Error(`Grok API error (${status}): ${errText}`);
      }
      
      const data = await response.json();
      let text = data.choices?.[0]?.message?.content?.trim() || "";
      if (text.startsWith("```")) {
        text = text.replace(/^```json\s*/, "").replace(/```$/, "").trim();
      }
      return JSON.parse(text);
    } catch (err) {
      console.error(`Grok Key #${i + 1} request threw error:`, err.message);
      lastError = err;
    }
  }

  throw new Error(`All configured Gemini and Grok API keys failed. Last error: ${lastError ? lastError.message : 'Unknown'}`);
}

let currentYoutubeKeyIndex = 0;

async function fetchWithYoutubeRotation(urlBuilderFn) {
  if (youtubeKeys.length === 0) {
    throw new Error("No YouTube API keys configured.");
  }

  let lastError;
  const startIndex = currentYoutubeKeyIndex;

  for (let attempt = 0; attempt < youtubeKeys.length; attempt++) {
    const keyIndex = (startIndex + attempt) % youtubeKeys.length;
    const key = youtubeKeys[keyIndex];
    const url = urlBuilderFn(key);

    try {
      const response = await fetch(url);
      if (response.ok) {
        currentYoutubeKeyIndex = keyIndex;
        return response;
      }

      console.error(`YouTube API request with Key #${keyIndex + 1} failed with status ${response.status}`);
      
      if (response.status === 429 || response.status === 403) {
        lastError = new Error(`QuotaExceeded (status ${response.status})`);
        continue;
      }

      return response;
    } catch (err) {
      console.error(`YouTube API request with Key #${keyIndex + 1} threw error:`, err.message);
      lastError = err;
    }
  }

  const quotaErr = new Error('QuotaExceeded');
  quotaErr.status = 429;
  quotaErr.message = `All configured YouTube API keys exhausted. Last error: ${lastError ? lastError.message : 'Unknown'}`;
  throw quotaErr;
}

// Verify suggestions via YouTube API in optimized batch
async function verifySuggestions(suggestions) {
  if (!suggestions || suggestions.length === 0) return [];

  // 1. Search YouTube for all suggestions in parallel
  const searchPromises = suggestions.map(async (talk) => {
    const query = `${talk.speaker} ${talk.title}`;
    
    let response;
    try {
      response = await fetchWithYoutubeRotation((key) => 
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&channelId=UCAuUUnT6oDeKwE6v1NGQxug&type=video&maxResults=1&key=${key}`
      );
    } catch (err) {
      console.error(`YouTube search fetch failed for "${talk.title}":`, err.message);
      if (err.message.includes('All configured YouTube API keys exhausted')) {
        throw err;
      }
      return null;
    }

    try {
      const data = await response.json();
      if (!data.items || data.items.length === 0) return null;
      
      const item = data.items[0];
      return {
        title: item.snippet.title,
        speaker: talk.speaker,
        reason: talk.reason,
        thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
        videoId: item.id.videoId,
        publishedAt: item.snippet.publishedAt
      };
    } catch (err) {
      console.error(`YouTube response parsing failed for "${talk.title}":`, err.message);
      return null;
    }
  });

  const searchedResults = (await Promise.all(searchPromises)).filter(item => item !== null);
  if (searchedResults.length === 0) return [];

  // 2. Batch query durations for all found video IDs (1 API request instead of N!)
  const videoIds = searchedResults.map(item => item.videoId).join(',');
  
  const durationsMap = {};
  const durationsRawMap = {};
  try {
    const response = await fetchWithYoutubeRotation((key) =>
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoIds}&key=${key}`
    );
    const data = await response.json();
    if (data.items) {
      data.items.forEach(video => {
        durationsMap[video.id] = parseDuration(video.contentDetails?.duration);
        durationsRawMap[video.id] = video.contentDetails?.duration;
      });
    }
  } catch (err) {
    if (err.message.includes('All configured YouTube API keys exhausted')) throw err;
    console.error("YouTube batch videos query failed:", err.message);
  }

  // 3. Map durations and filter out YouTube Shorts (duration < 2 minutes)
  return searchedResults
    .map(item => ({
      title: item.title,
      speaker: item.speaker,
      duration: durationsMap[item.videoId] || "N/A",
      thumbnail: item.thumbnail,
      videoId: item.videoId,
      reason: item.reason,
      publishedAt: item.publishedAt,
      durationSec: getDurationSeconds(durationsRawMap[item.videoId])
    }))
    .filter(item => item.durationSec >= 120);
}

// Fetch and verify recent videos (within last 365 days) from TED channel using multi-strategy search
async function fetchRecentTalks(topic) {
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const publishedAfter = oneYearAgo.toISOString();

  let allRawItems = [];
  const seenIds = new Set();

  // Helper to query search endpoint and return parsed items with pagination support
  async function querySearch(queryStr, order, pageToken = '') {
    try {
      const response = await fetchWithYoutubeRotation((key) => {
        let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(queryStr)}&channelId=UCAuUUnT6oDeKwE6v1NGQxug&type=video&order=${order}&publishedAfter=${publishedAfter}&maxResults=50&key=${key}`;
        if (pageToken) url += `&pageToken=${pageToken}`;
        return url;
      });
      if (response.ok) {
        return await response.json();
      }
      console.error(`YouTube API returned status ${response.status} for query "${queryStr}"`);
      return null;
    } catch (err) {
      console.error(`YouTube API query failed for "${queryStr}":`, err.message);
      if (err.message.includes('All configured YouTube API keys exhausted')) {
        throw err;
      }
      return null;
    }
  }

  // Helper to filter, parse, and score search items
  function processItems(items) {
    const processed = [];
    if (!items) return processed;

    for (const item of items) {
      const videoId = item.id?.videoId;
      if (!videoId || seenIds.has(videoId)) continue;

      const title = item.snippet?.title || "";
      const desc = item.snippet?.description || "";
      const score = getRelevanceScore(title, desc, topic);

      // Discard irrelevant results (score === 0)
      if (score === 0) continue;

      seenIds.add(videoId);
      const parsed = parseTedTitle(title);

      processed.push({
        title: parsed.title || title,
        speaker: parsed.speaker,
        thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
        videoId: videoId,
        publishedAt: item.snippet.publishedAt,
        reason: "Recently uploaded talk matching search topic.",
        relevanceScore: score
      });
    }
    return processed;
  }

  console.log(`[Recent Talks Search] Starting search for "${topic}"`);

  // --- Phase 1: Exact Phrase Search ---
  console.log(`[Search Phase 1] Querying exact phrase: "${topic}"`);
  const exactResponse = await querySearch(`"${topic}"`, 'date');
  let exactItems = exactResponse?.items || [];
  let processedItems = processItems(exactItems);
  allRawItems.push(...processedItems);

  let nextPageToken = exactResponse?.nextPageToken;

  // Check if we already have 8 or more relevant results
  let relevantCount = allRawItems.filter(item => item.relevanceScore >= 0.5).length;
  console.log(`[Search Phase 1] Found ${processedItems.length} new items. Total relevant: ${relevantCount}`);

  // --- Phase 2: Broad Keyword Search (If < 8 relevant results) ---
  let broadResponse = null;
  if (relevantCount < 8) {
    console.log(`[Search Phase 2] Escalating to broad search for: ${topic}`);
    broadResponse = await querySearch(topic, 'date');
    const broadItems = broadResponse?.items || [];
    const processedBroad = processItems(broadItems);
    allRawItems.push(...processedBroad);
    relevantCount = allRawItems.filter(item => item.relevanceScore >= 0.5).length;
    console.log(`[Search Phase 2] Found ${processedBroad.length} new items. Total relevant: ${relevantCount}`);
  }

  // --- Phase 3: Pagination (If still < 8 relevant results & nextPageToken is available) ---
  let pageCapCount = 0;
  // Prioritize exact phrase nextPageToken if broad wasn't run, otherwise broad's nextPageToken
  let activePageToken = broadResponse ? broadResponse.nextPageToken : nextPageToken;
  let activeQuery = broadResponse ? topic : `"${topic}"`;

  while (relevantCount < 8 && activePageToken && pageCapCount < 2) {
    console.log(`[Search Phase 3] Paginated escalation using token "${activePageToken}" for query "${activeQuery}"`);
    const pageResponse = await querySearch(activeQuery, 'date', activePageToken);
    if (!pageResponse) break;

    const pageItems = pageResponse.items || [];
    const processedPage = processItems(pageItems);
    allRawItems.push(...processedPage);

    relevantCount = allRawItems.filter(item => item.relevanceScore >= 0.5).length;
    activePageToken = pageResponse.nextPageToken;
    pageCapCount++;
    console.log(`[Search Phase 3 Page ${pageCapCount}] Found ${processedPage.length} new items. Total relevant: ${relevantCount}`);
  }

  // If no results found, return empty
  if (allRawItems.length === 0) return [];

  // Sort by relevance score (descending) then by publish date (newest first)
  allRawItems.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) {
      return b.relevanceScore - a.relevanceScore;
    }
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });

  // Limit to max results of 6 for Recent Uploads section
  const topRecentTalks = allRawItems.slice(0, 6);
  console.log(`[Recent Talks Search] Retaining ${topRecentTalks.length} highest-scoring recent talks.`);

  // Batch fetch durations for the top 6 recent talks
  const videoIds = topRecentTalks.map(item => item.videoId).join(',');
  if (!videoIds) return [];

  const durationsMap = {};
  const durationsRawMap = {};
  try {
    const durationResponse = await fetchWithYoutubeRotation((key) =>
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoIds}&key=${key}`
    );
    const durationData = await durationResponse.json();
    if (durationData.items) {
      durationData.items.forEach(video => {
        durationsMap[video.id] = parseDuration(video.contentDetails?.duration);
        durationsRawMap[video.id] = video.contentDetails?.duration;
      });
    }
  } catch (err) {
    console.error("YouTube batch recent videos duration query failed:", err.message);
  }

  return topRecentTalks
    .map(item => ({
      title: item.title,
      speaker: item.speaker,
      thumbnail: item.thumbnail,
      videoId: item.videoId,
      publishedAt: item.publishedAt,
      reason: item.reason,
      duration: durationsMap[item.videoId] || "N/A",
      durationSec: getDurationSeconds(durationsRawMap[item.videoId])
    }))
    .filter(item => item.durationSec >= 120);
}

// Simple in-memory cache for search topics
const searchCache = new Map();

// GET Endpoint: Overall latest uploads on TED channel (Homepage feed)
app.get('/api/recent-uploads', async (req, res) => {
  console.log("Received request for overall latest TED uploads...");

  const hasYoutubeKeys = youtubeKeys.length > 0;
  if (!hasYoutubeKeys) {
    console.log("Mocking overall latest uploads...");
    const mockRecent = [
      {
        title: "The power of vulnerability",
        speaker: "Brené Brown",
        duration: "20 min",
        thumbnail: "https://img.youtube.com/vi/iCvmsMzlF7o/hqdefault.jpg",
        youtubeLink: "https://www.youtube.com/watch?v=iCvmsMzlF7o",
        reason: "One of the most watched TED talks about connection, courage, and shame.",
        publishedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
      },
      {
        title: "How to make stress your friend",
        speaker: "Kelly McGonigal",
        duration: "14 min",
        thumbnail: "https://img.youtube.com/vi/RcGyVTAoXEU/hqdefault.jpg",
        youtubeLink: "https://www.youtube.com/watch?v=RcGyVTAoXEU",
        reason: "Viewing stress as helpful can reduce its physiological harms.",
        publishedAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString()
      },
      {
        title: "Inside the mind of a master procrastinator",
        speaker: "Tim Urban",
        duration: "14 min",
        thumbnail: "https://img.youtube.com/vi/arj7oStGLkU/hqdefault.jpg",
        youtubeLink: "https://www.youtube.com/watch?v=arj7oStGLkU",
        reason: "A hilarious and deeply relatable look into why we delay tasks.",
        publishedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()
      }
    ];
    return res.json({ results: mockRecent });
  }

  try {
    // Search latest videos from TED channel without keyword
    const response = await fetchWithYoutubeRotation((key) =>
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=UCAuUUnT6oDeKwE6v1NGQxug&type=video&order=date&maxResults=6&key=${key}`
    );
    const data = await response.json();
    if (!data.items || data.items.length === 0) {
      return res.json({ results: [] });
    }

    const recentTalksList = data.items.map(item => {
      const parsed = parseTedTitle(item.snippet.title);
      return {
        title: parsed.title || item.snippet.title,
        speaker: parsed.speaker,
        thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
        videoId: item.id.videoId,
        publishedAt: item.snippet.publishedAt,
        reason: "Latest upload on official TED channel."
      };
    });

    // Batch fetch durations
    const videoIds = recentTalksList.map(item => item.videoId).join(',');
    const durationsMap = {};
    const durationsRawMap = {};
    if (videoIds) {
      try {
        const durationResponse = await fetchWithYoutubeRotation((key) =>
          `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoIds}&key=${key}`
        );
        const durationData = await durationResponse.json();
        if (durationData.items) {
          durationData.items.forEach(video => {
            durationsMap[video.id] = parseDuration(video.contentDetails?.duration);
            durationsRawMap[video.id] = video.contentDetails?.duration;
          });
        }
      } catch (err) {
        console.error("YouTube batch recent uploads duration query failed:", err.message);
      }
    }

    const results = recentTalksList
      .map(item => ({
        ...item,
        duration: durationsMap[item.videoId] || "N/A",
        youtubeLink: `https://www.youtube.com/watch?v=${item.videoId}`,
        durationSec: getDurationSeconds(durationsRawMap[item.videoId])
      }))
      .filter(item => item.durationSec >= 120);

    return res.json({ results });
  } catch (error) {
    console.error("Error fetching overall latest TED uploads:", error);
    return res.status(500).json({ error: "Failed to fetch recent uploads." });
  }
});

// POST Endpoint: Find TED Talks
app.post('/api/find-talks', async (req, res) => {
  const { topic } = req.body;
  if (!topic || typeof topic !== 'string' || topic.trim() === '') {
    return res.status(400).json({ error: "A search topic is required." });
  }

  const cleanTopic = topic.trim();
  const cacheKey = cleanTopic.toLowerCase();

  // Check cache hit
  if (searchCache.has(cacheKey)) {
    console.log(`[Cache Hit] Returning cached results for topic: "${cleanTopic}"`);
    return res.json(searchCache.get(cacheKey));
  }

  console.log(`[Cache Miss] Fetching results for topic: "${cleanTopic}"`);

  // Override res.json to automatically cache successful responses
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    if (data && !data.quotaExceeded && res.statusCode === 200) {
      searchCache.set(cacheKey, data);
      console.log(`[Cache Store] Cached results for topic: "${cleanTopic}"`);
    }
    return originalJson(data);
  };

  const hasGeminiKeys = geminiKeys.length > 0;
  const hasGrokKeys = grokKeys.length > 0;
  const hasYoutubeKeys = youtubeKeys.length > 0;

  // Fallback to Mock Mode if keys are not set
  if ((!hasGeminiKeys && !hasGrokKeys) || !hasYoutubeKeys) {
    console.log("Using Mock Mode (API keys are unconfigured placeholders)...");

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 1500));

    const lowercaseTopic = cleanTopic.toLowerCase();

    // Procrastination Mock
    if (lowercaseTopic.includes("procrastinat")) {
      const results = [
        {
          title: "Inside the mind of a master procrastinator",
          speaker: "Tim Urban",
          duration: "14 min",
          thumbnail: "https://img.youtube.com/vi/arj7oStGLkU/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=arj7oStGLkU",
          reason: "A hilarious and deeply relatable look into why we delay tasks and how the instant gratification monkey takes control."
        },
        {
          title: "Why we procrastinate",
          speaker: "Vik Nithy",
          duration: "10 min",
          thumbnail: "https://img.youtube.com/vi/WD440CY2VS0/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=WD440CY2VS0",
          reason: "An insightful look at the neuroscience of procrastination and how to bypass the amygdala hijack."
        },
        {
          title: "The 5 Second Rule to Beat Procrastination",
          speaker: "Mel Robbins",
          duration: "21 min",
          thumbnail: "https://img.youtube.com/vi/HSn-yv5U8a4/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=HSn-yv5U8a4",
          reason: "Introduces the famous 5-second countdown to bypass mental resistance and take immediate action."
        },
        {
          title: "How to stop procrastinating",
          speaker: "Claryss Nantha",
          duration: "12 min",
          thumbnail: "https://img.youtube.com/vi/52L_LyGKsW4/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=52L_LyGKsW4",
          reason: "A practical guide proposing strategies to overcome standard everyday procrastination obstacles."
        },
        {
          title: "The procrastination cure",
          speaker: "Celina Decaestecker",
          duration: "9 min",
          thumbnail: "https://img.youtube.com/vi/pZg1N9v3_gY/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=pZg1N9v3_gY",
          reason: "Investigates the psychology of task aversion and provides a simple mindfulness roadmap to resolve it."
        },
        {
          title: "Procrastination: A scientific guide",
          speaker: "James Clear",
          duration: "15 min",
          thumbnail: "https://img.youtube.com/vi/H14bBuluwB8/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=H14bBuluwB8",
          reason: "Applies atomic habits principles to break down how to stop delaying and build consistent momentum."
        },
        {
          title: "How to deal with procrastination",
          speaker: "Sarah Jane",
          duration: "11 min",
          thumbnail: "https://img.youtube.com/vi/co-M7tU5iN4/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=co-M7tU5iN4",
          reason: "A series of cognitive tools to reframe tasks and lower emotional barriers that cause procrastination."
        },
        {
          title: "A brief history of procrastination",
          speaker: "Heather Watson",
          duration: "8 min",
          thumbnail: "https://img.youtube.com/vi/fK1P7L4m2cE/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=fK1P7L4m2cE",
          reason: "Explores how procrastination is not a modern disease but has been documented since ancient Greece."
        },
        {
          title: "Why you procrastinate, and how to stop",
          speaker: "Dr. Tim Pychyl",
          duration: "18 min",
          thumbnail: "https://img.youtube.com/vi/H25M9yN4f20/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=H25M9yN4f20",
          reason: "Reviews 20 years of research on emotional regulation and outlines simple tips to beat procrastination."
        },
        {
          title: "Overcoming procrastination: A practical approach",
          speaker: "Natasha Hurley",
          duration: "13 min",
          thumbnail: "https://img.youtube.com/vi/o5mB9vN4k22/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=o5mB9vN4k22",
          reason: "Focuses on chunking projects and reducing cognitive overhead to bypass anxiety-driven task delay."
        },
        {
          title: "The art of structured procrastination",
          speaker: "John Perry",
          duration: "16 min",
          thumbnail: "https://img.youtube.com/vi/M25F8xY4l50/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=M25F8xY4l50",
          reason: "Introduces structured procrastination, a strategy where you accomplish huge tasks to avoid even bigger ones."
        },
        {
          title: "Stop procrastinating: The secret is simple",
          speaker: "Jane Chen",
          duration: "10 min",
          thumbnail: "https://img.youtube.com/vi/A24L9kK5v88/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=A24L9kK5v88",
          reason: "A brief, high-impact talk providing three simple habits to overcome chronic task avoidance."
        }
      ];

      const resultsWithDates = results.map((item, idx) => ({
        ...item,
        publishedAt: new Date(Date.UTC(2012 + Math.floor(idx / 1.5), (idx * 4) % 12, (idx * 7) % 28)).toISOString()
      }));

      const mockRecentProcrastination = [
        {
          title: "How to design a procrastination-free environment",
          speaker: "James Clear",
          duration: "11 min",
          thumbnail: "https://img.youtube.com/vi/WD440CY2VS0/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=WD440CY2VS0",
          reason: "Practical tips on modifying your physical and digital workspace to avoid procrastination.",
          publishedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
        },
        {
          title: "Why micro-habits beat chronic delay",
          speaker: "BJ Fogg",
          duration: "15 min",
          thumbnail: "https://img.youtube.com/vi/co-M7tU5iN4/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=co-M7tU5iN4",
          reason: "An analysis of tiny behavioral changes that bypass the brain's resistance to starting complex tasks.",
          publishedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString()
        }
      ];

      return res.json({ topic: cleanTopic, results: resultsWithDates, recentResults: mockRecentProcrastination });
    }

    // Stress Mock
    if (lowercaseTopic.includes("stress") || lowercaseTopic.includes("anxi")) {
      const results = [
        {
          title: "How to make stress your friend",
          speaker: "Kelly McGonigal",
          duration: "14 min",
          thumbnail: "https://img.youtube.com/vi/RcGyVTAoXEU/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=RcGyVTAoXEU",
          reason: "Presents groundbreaking research showing that viewing stress as helpful can reduce its physiological harms."
        },
        {
          title: "How stress affects your body",
          speaker: "Sharon Horesh Bergquist",
          duration: "4 min",
          thumbnail: "https://img.youtube.com/vi/v-t1Z5-oGhU/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=v-t1Z5-oGhU",
          reason: "An engaging animated explanation of the biology of stress hormones and their chronic effects."
        },
        {
          title: "All it takes is 10 mindful minutes",
          speaker: "Andy Puddicombe",
          duration: "9 min",
          thumbnail: "https://img.youtube.com/vi/qzR62JJCMBQ/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=qzR62JJCMBQ",
          reason: "Presents mindfulness techniques to reset your brain and handle daily pressures with clarity."
        },
        {
          title: "The upside of stress",
          speaker: "Kelly McGonigal",
          duration: "18 min",
          thumbnail: "https://img.youtube.com/vi/f2K8l7Y4m99/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=f2K8l7Y4m99",
          reason: "Deepens the case for adopting a positive mindset toward stress to trigger courage and social bonding."
        },
        {
          title: "How to manage stress",
          speaker: "Dr. Rangan Chatterjee",
          duration: "15 min",
          thumbnail: "https://img.youtube.com/vi/E92L9kK5y80/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=E92L9kK5y80",
          reason: "Proposes actionable, low-cost lifestyle interventions to regulate cortisol levels and build resilience."
        },
        {
          title: "Stress: A portrait of a killer",
          speaker: "Robert Sapolsky",
          duration: "22 min",
          thumbnail: "https://img.youtube.com/vi/S82M9yX4v11/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=S82M9yX4v11",
          reason: "A fascinating look at baboon groups showing how social status affects stress biology and general health."
        },
        {
          title: "How to turn stress into strength",
          speaker: "Dr. Alia Crum",
          duration: "14 min",
          thumbnail: "https://img.youtube.com/vi/B92M7tU5v55/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=B92M7tU5v55",
          reason: "Reviews psychology studies showing that stress mindsets dictate cognitive performance and physical health."
        },
        {
          title: "Stress at work and how to beat it",
          speaker: "Rob Cooke",
          duration: "11 min",
          thumbnail: "https://img.youtube.com/vi/C22L9kK5y44/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=C22L9kK5y44",
          reason: "Addresses the systemic factors causing workplace burnout and suggests individual boundaries to protect mental health."
        },
        {
          title: "Why stress is good for you",
          speaker: "Dr. Firdaus Dhabhar",
          duration: "13 min",
          thumbnail: "https://img.youtube.com/vi/D92M8tU5w66/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=D92M8tU5w66",
          reason: "Differentiates acute stress (which boosts immune responses) from chronic stress (which suppresses them)."
        },
        {
          title: "The science of stress and resilience",
          speaker: "Dr. Bruce McEwen",
          duration: "16 min",
          thumbnail: "https://img.youtube.com/vi/F92M9tU5y77/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=F92M9tU5y77",
          reason: "Explores the concept of allostatic load: the wear and tear on the body from long-term stress exposure."
        },
        {
          title: "Mindfulness, stress and the brain",
          speaker: "Dr. Jon Kabat-Zinn",
          duration: "20 min",
          thumbnail: "https://img.youtube.com/vi/G92M0tU5z88/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=G92M0tU5z88",
          reason: "The creator of MBSR explains how regular meditation changes brain structures associated with stress."
        },
        {
          title: "Breathing your way out of stress",
          speaker: "Max Strom",
          duration: "15 min",
          thumbnail: "https://img.youtube.com/vi/H92M1tU5a99/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=H92M1tU5a99",
          reason: "Demonstrates simple breath control patterns that immediately trigger the parasympathetic nervous system."
        }
      ];

      const resultsWithDates = results.map((item, idx) => ({
        ...item,
        publishedAt: new Date(Date.UTC(2013 + Math.floor(idx / 1.5), (idx * 4) % 12, (idx * 7) % 28)).toISOString()
      }));

      const mockRecentStress = [
        {
          title: "The neurobiology of sudden stress relief",
          speaker: "Dr. Andrew Huberman",
          duration: "13 min",
          thumbnail: "https://img.youtube.com/vi/qzR62JJCMBQ/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=qzR62JJCMBQ",
          reason: "Explores the double-sigh breathing technique to down-regulate the nervous system within seconds.",
          publishedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
        },
        {
          title: "Why collective stress calls for connection",
          speaker: "Dr. Vivek Murthy",
          duration: "16 min",
          thumbnail: "https://img.youtube.com/vi/E92L9kK5y80/hqdefault.jpg",
          youtubeLink: "https://www.youtube.com/watch?v=E92L9kK5y80",
          reason: "A look at social connection as a biological buffer against chronic work stressors.",
          publishedAt: new Date(Date.now() - 150 * 24 * 60 * 60 * 1000).toISOString()
        }
      ];

      return res.json({ topic: cleanTopic, results: resultsWithDates, recentResults: mockRecentStress });
    }

    // Generic Mock (Generate 12 videos)
    const topicTitle = cleanTopic.charAt(0).toUpperCase() + cleanTopic.slice(1);
    const mockVideosList = [];
    const mockTemplates = [
      { id: "5S71M5zCjZ0", speaker: "Dr. Sarah Jenkins", title: `How ${topicTitle} Shapes Our Future` },
      { id: "arj7oStGLkU", speaker: "Prof. Marcus Thorne", title: `The Hidden Science of ${topicTitle}` },
      { id: "RcGyVTAoXEU", speaker: "Elena Rostova", title: `Reimagining ${topicTitle} in the Modern Era` },
      { id: "v-t1Z5-oGhU", speaker: "Dr. David Vance", title: `Why We Must Talk About ${topicTitle}` },
      { id: "qzR62JJCMBQ", speaker: "Nisha Patel", title: `The Art of ${topicTitle}` },
      { id: "WD440CY2VS0", speaker: "Simon Sinek Jr.", title: `${topicTitle} and the Power of Purpose` }
    ];

    for (let i = 0; i < 12; i++) {
      const template = mockTemplates[i % mockTemplates.length];

      mockVideosList.push({
        title: `${template.title} (Part ${Math.floor(i / 6) + 1})`,
        speaker: template.speaker,
        duration: `${10 + (i * 2)} min`,
        thumbnail: `https://img.youtube.com/vi/${template.id}/hqdefault.jpg`,
        youtubeLink: `https://www.youtube.com/watch?v=${template.id}`,
        reason: `A detailed, comprehensive video discussing how ${cleanTopic} affects our daily lives and long-term goals.`,
        publishedAt: new Date(Date.UTC(2015 + Math.floor(i / 2), (i * 3) % 12, 1)).toISOString()
      });
    }

    const mockRecentGeneric = [
      {
        title: `${topicTitle} and the future of science`,
        speaker: "Dr. Sarah Jenkins",
        duration: "12 min",
        thumbnail: "https://img.youtube.com/vi/5S71M5zCjZ0/hqdefault.jpg",
        youtubeLink: "https://www.youtube.com/watch?v=5S71M5zCjZ0",
        reason: `A groundbreaking discussion of recent scientific advancements in the field of ${cleanTopic}.`,
        publishedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
      }
    ];

    return res.json({
      topic: cleanTopic,
      results: mockVideosList,
      recentResults: mockRecentGeneric
    });
  }

  let suggestions = [];
  try {
    if (youtubeKeys.length === 0) {
      return res.status(500).json({ error: "YouTube API key is missing on the server configuration. Please add YOUTUBE_API_KEYS to the .env file." });
    }

    // 1. Get AI suggestions
    console.log("Fetching AI suggestions...");
    suggestions = await getAISuggestions(cleanTopic);
    console.log(`AI suggested ${suggestions.length || 0} talks. Verifying on YouTube...`);

    // 2. Fetch both curated and recent talks in parallel
    console.log("Verifying curated talks & searching recent uploads...");
    const [verifiedTalks, recentTalks] = await Promise.all([
      verifySuggestions(suggestions || []),
      fetchRecentTalks(cleanTopic)
    ]);

    const results = verifiedTalks.map(v => ({
      ...v,
      youtubeLink: `https://www.youtube.com/watch?v=${v.videoId}`
    }));

    const recentResults = recentTalks.map(v => ({
      ...v,
      youtubeLink: `https://www.youtube.com/watch?v=${v.videoId}`
    }));

    console.log(`Verification complete. ${results.length} curated talks verified, ${recentResults.length} recent talks found.`);

    if (results.length === 0 && recentResults.length === 0) {
      return res.status(404).json({
        error: "Couldn't find verified talks for this topic — try a different or broader topic.",
        results: [],
        recentResults: []
      });
    }

    return res.json({
      topic: cleanTopic,
      results,
      recentResults
    });
  } catch (error) {
    console.error("Backend error processing request:", error);
    if (error.message.includes('QuotaExceeded') || error.status === 429 || error.status === 403) {
      console.log("YouTube API Quota Exceeded. Falling back to AI suggestions...");
      if (suggestions && suggestions.length > 0) {
        const fallbackResults = suggestions.map(talk => {
          let publishedAt = undefined;
          if (talk.year) {
            const yearNum = parseInt(talk.year);
            if (!isNaN(yearNum)) {
              publishedAt = new Date(Date.UTC(yearNum, 0, 1)).toISOString();
            }
          }
          return {
            title: talk.title,
            speaker: talk.speaker,
            duration: "N/A",
            thumbnail: "https://images.unsplash.com/photo-1475721027785-f74eccf877e2?q=80&w=600&auto=format&fit=crop",
            youtubeLink: `https://www.youtube.com/results?search_query=${encodeURIComponent(talk.speaker + ' ' + talk.title)}`,
            reason: talk.reason,
            publishedAt: publishedAt
          };
        });
        return res.json({
          topic: cleanTopic,
          results: fallbackResults,
          recentResults: [],
          quotaExceeded: true
        });
      } else {
        return res.status(429).json({ 
          error: "YouTube API quota exceeded (Error 429/403) and AI suggestions could not be generated. Please try again later."
        });
      }
    }
    return res.status(500).json({ 
      error: `An error occurred while finding talks: ${error.message || "Please check server logs and configuration."}`
    });
  }
});

// Contact Form Submission endpoint
app.post('/api/contact', async (req, res) => {
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

    console.log(`Attempting to send email via Resend API to: ${toEmail}...`);

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
          subject: `[TED Talk Finder] New Contact Submission: ${subject}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 5px;">
              <h2 style="color: #EB0028; border-bottom: 2px solid #EB0028; padding-bottom: 10px; text-transform: uppercase; font-size: 18px; tracking-wider;">
                New Contact Form Submission
              </h2>
              <p style="margin: 15px 0;"><strong>Name:</strong> ${name}</p>
              <p style="margin: 15px 0;"><strong>Email:</strong> <a href="mailto:${email}" style="color: #EB0028; text-decoration: none;">${email}</a></p>
              <p style="margin: 15px 0;"><strong>Subject:</strong> ${subject}</p>
              <p style="margin: 15px 0; font-weight: bold;">Message:</p>
              <div style="white-space: pre-wrap; background: #f9f9f9; padding: 15px; border-left: 4px solid #EB0028; font-size: 14px; color: #333; line-height: 1.5; margin-top: 5px;">${message}</div>
              <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
              <p style="font-size: 11px; color: #999; text-align: center;">This message was automatically generated by TED Talk Finder.</p>
            </div>
          `
        })
      });

      const resData = await response.json();
      if (!response.ok) {
        console.error("Resend API returned error:", resData);
        return res.status(502).json({ error: `Failed to send email via Resend API: ${resData.message || response.statusText}` });
      }

      console.log("Email sent successfully! Resend ID:", resData.id);
    } catch (emailError) {
      console.error("Failed to transmit email through Resend API:", emailError);
      return res.status(502).json({ error: "Failed to transmit email through Resend. Please check server logs." });
    }
  } else {
    console.log("Resend API Key is not configured in .env. Submission logged to console only.");
  }

  return res.json({ success: true, message: "Your message has been received. Thank you!" });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});

