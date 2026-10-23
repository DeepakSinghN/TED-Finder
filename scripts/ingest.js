import dotenv from 'dotenv';
import db, { initDatabase } from '../db/index.js';
import { parseDuration, getDurationSeconds, parseSpeakerAndTitle } from '../db/utils.js';
import { seedChannels } from '../db/seedChannels.js';
import { CURATED_TALKS } from '../db/curatedTalks.js';

dotenv.config();

// Ensure DB and seed channels are ready
initDatabase();
seedChannels();

// Clean and extract YouTube API keys
const rawKeys = process.env.YOUTUBE_API_KEYS || process.env.YOUTUBE_API_KEY || '';
const cleanKey = (k) => k?.trim().replace(/^['"]|['"]$/g, '').trim();
const isPlaceholder = (k) => !k || k.toUpperCase().includes('YOUR_') || k.includes('api_key');
const youtubeKeys = rawKeys.split(',').map(cleanKey).filter(Boolean).filter(k => !isPlaceholder(k));

let keyIndex = 0;
let totalQuotaUnitsUsed = 0;

function getActiveKey() {
  if (youtubeKeys.length === 0) return null;
  return youtubeKeys[keyIndex % youtubeKeys.length];
}

function rotateKey() {
  if (youtubeKeys.length > 1) {
    keyIndex = (keyIndex + 1) % youtubeKeys.length;
    console.log(`[YouTube API] Rotated to key #${keyIndex + 1}`);
  }
}

// Prepared Statements for high-performance batch insertion
const upsertTalkStmt = db.prepare(`
  INSERT INTO talks (
    video_id, channel_id, title, speaker, description,
    duration_sec, duration_formatted, thumbnail_url,
    published_at, view_count, summary, tags, updated_at
  ) VALUES (
    @video_id, @channel_id, @title, @speaker, @description,
    @duration_sec, @duration_formatted, @thumbnail_url,
    @published_at, @view_count, @summary, @tags, CURRENT_TIMESTAMP
  )
  ON CONFLICT(video_id) DO UPDATE SET
    title = excluded.title,
    speaker = excluded.speaker,
    duration_sec = excluded.duration_sec,
    duration_formatted = excluded.duration_formatted,
    thumbnail_url = excluded.thumbnail_url,
    view_count = excluded.view_count,
    summary = COALESCE(talks.summary, excluded.summary),
    tags = COALESCE(talks.tags, excluded.tags),
    updated_at = CURRENT_TIMESTAMP;
`);

const deleteFtsStmt = db.prepare(`DELETE FROM talks_fts WHERE video_id = ?`);
const insertFtsStmt = db.prepare(`
  INSERT INTO talks_fts (video_id, title, speaker, description, summary, tags)
  VALUES (@video_id, @title, @speaker, @description, @summary, @tags);
`);

const updateChannelSyncStmt = db.prepare(`
  UPDATE channels SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?
`);

// Insert a single talk and update FTS inside a transaction
export const saveTalk = db.transaction((talk) => {
  upsertTalkStmt.run(talk);
  deleteFtsStmt.run(talk.video_id);
  insertFtsStmt.run({
    video_id: talk.video_id,
    title: talk.title,
    speaker: talk.speaker || '',
    description: talk.description || '',
    summary: talk.summary || '',
    tags: talk.tags || ''
  });
});

// Real mock talks across all 8 channels for instant local testing without API keys
const MOCK_TALKS = [
  {
    video_id: "iCvmsMzlF7o",
    channel_id: "UCAuUUnT6oDeKwE6v1NGQxug", // TED
    title: "The power of vulnerability",
    speaker: "Brené Brown",
    description: "Brené Brown studies human connection -- our ability to empathize, belong, love. In a poignant, funny talk, she shares a deep insight from her research.",
    duration_sec: 1219,
    duration_formatted: "20 min",
    thumbnail_url: "https://img.youtube.com/vi/iCvmsMzlF7o/hqdefault.jpg",
    published_at: "2010-12-23T15:23:00Z",
    view_count: 65000000,
    summary: "Vulnerability is not weakness; it is the birthplace of courage, connection, and empathy. Embracing our imperfections unlocks genuine relationships.",
    tags: JSON.stringify(["vulnerability", "courage", "relationships", "psychology", "mental health"])
  },
  {
    video_id: "arj7oStGLkU",
    channel_id: "UCAuUUnT6oDeKwE6v1NGQxug", // TED
    title: "Inside the mind of a master procrastinator",
    speaker: "Tim Urban",
    description: "Tim Urban knows that procrastination doesn't make sense, but he's never been able to shake his habit of waiting until the last minute.",
    duration_sec: 844,
    duration_formatted: "14 min",
    thumbnail_url: "https://img.youtube.com/vi/arj7oStGLkU/hqdefault.jpg",
    published_at: "2016-04-06T14:48:00Z",
    view_count: 72000000,
    summary: "A hilarious exploration of why our brains delay hard tasks until the Panic Monster wakes up, and why long-term deadlines without alarms cause true regret.",
    tags: JSON.stringify(["procrastination", "habits", "productivity", "psychology", "focus"])
  },
  {
    video_id: "RcGyVTAoXEU",
    channel_id: "UCAuUUnT6oDeKwE6v1NGQxug", // TED
    title: "How to make stress your friend",
    speaker: "Kelly McGonigal",
    description: "While stress has been made into a public health enemy, new research suggests that stress may only be bad for you if you believe that to be the case.",
    duration_sec: 868,
    duration_formatted: "14 min",
    thumbnail_url: "https://img.youtube.com/vi/RcGyVTAoXEU/hqdefault.jpg",
    published_at: "2013-09-04T15:10:00Z",
    view_count: 32000000,
    summary: "Changing your mindset about stress reshapes how your cardiovascular system reacts, transforming fear into courage and connection.",
    tags: JSON.stringify(["stress", "anxiety", "health", "mindset", "resilience"])
  },
  {
    video_id: "Ks-_Mh1QhMc",
    channel_id: "UCAuUUnT6oDeKwE6v1NGQxug", // TED
    title: "Your body language may shape who you are",
    speaker: "Amy Cuddy",
    description: "Body language affects how others see us, but it may also change how we see ourselves. Social psychologist Amy Cuddy argues that power posing can boost confidence.",
    duration_sec: 1262,
    duration_formatted: "21 min",
    thumbnail_url: "https://img.youtube.com/vi/Ks-_Mh1QhMc/hqdefault.jpg",
    published_at: "2012-10-01T15:00:00Z",
    view_count: 70000000,
    summary: "Assuming two-minute expansive power poses triggers physiological shifts that increase confidence and decrease stress before high-stakes challenges.",
    tags: JSON.stringify(["confidence", "body language", "interviews", "communication", "psychology"])
  },
  {
    video_id: "qp0HIF3SfI4",
    channel_id: "UCAuUUnT6oDeKwE6v1NGQxug", // TED
    title: "How great leaders inspire action (Start with Why)",
    speaker: "Simon Sinek",
    description: "Simon Sinek has a simple but powerful model for inspirational leadership -- starting with a golden circle and the question: Why?",
    duration_sec: 1084,
    duration_formatted: "18 min",
    thumbnail_url: "https://img.youtube.com/vi/qp0HIF3SfI4/hqdefault.jpg",
    published_at: "2010-05-04T13:45:00Z",
    view_count: 62000000,
    summary: "People don't buy what you do; they buy why you do it. Great leaders and movements communicate from the inside out starting with core purpose.",
    tags: JSON.stringify(["leadership", "startups", "communication", "business", "inspiration"])
  },
  {
    video_id: "Cpc-t-Uwv1I",
    channel_id: "UCxIJaCMEptJjxmmQgGFsnCg", // Y Combinator
    title: "How to Build the Future",
    speaker: "Sam Altman",
    description: "Sam Altman shares core lessons on founding high-conviction companies, technology compounding, and staying focused on what users want.",
    duration_sec: 1840,
    duration_formatted: "30 min",
    thumbnail_url: "https://img.youtube.com/vi/Cpc-t-Uwv1I/hqdefault.jpg",
    published_at: "2018-09-12T16:00:00Z",
    view_count: 1800000,
    summary: "Building enduring startups requires compound thinking, extreme persistence, obsession with customer love, and building real utility.",
    tags: JSON.stringify(["startups", "entrepreneurship", "tech", "leadership", "building products"])
  },
  {
    video_id: "bNZv4eq5Xj4",
    channel_id: "UCxIJaCMEptJjxmmQgGFsnCg", // Y Combinator
    title: "How to Get Startup Ideas",
    speaker: "Paul Graham & Dalton Caldwell",
    description: "Where great ideas come from: notice what's missing in your own life and build things that don't scale at first.",
    duration_sec: 1420,
    duration_formatted: "23 min",
    thumbnail_url: "https://img.youtube.com/vi/bNZv4eq5Xj4/hqdefault.jpg",
    published_at: "2020-03-15T18:00:00Z",
    view_count: 950000,
    summary: "The best startup ideas look like bad ideas initially. Look for real problems at the frontier of technology and solve them for an enthusiastic niche.",
    tags: JSON.stringify(["startups", "ideas", "business", "innovation", "entrepreneurship"])
  },
  {
    video_id: "UF8uR6Z6KLc",
    channel_id: "UC3eNlJKuJzJfNQzLphGZW7w", // Stanford
    title: "Steve Jobs' 2005 Stanford Commencement Address",
    speaker: "Steve Jobs",
    description: "At his Stanford commencement speech, Steve Jobs urged graduates to pursue their dreams and see the opportunities in life's setbacks.",
    duration_sec: 904,
    duration_formatted: "15 min",
    thumbnail_url: "https://img.youtube.com/vi/UF8uR6Z6KLc/hqdefault.jpg",
    published_at: "2008-03-07T19:35:00Z",
    view_count: 45000000,
    summary: "Three foundational stories: connecting the dots looking back, love and loss as catalysts for greatness, and remembering death as the best tool to avoid fear.",
    tags: JSON.stringify(["inspiration", "life lessons", "career", "purpose", "philosophy"])
  },
  {
    video_id: "mDnmX5Q43l0",
    channel_id: "UCEBb1b_L6zDS3xTUrIALZOw", // Big Think
    title: "How to stop overthinking and take action",
    speaker: "Mel Robbins",
    description: "Mel Robbins introduces the practical neuroscience behind the 5-second decision window to break hesitation.",
    duration_sec: 630,
    duration_formatted: "10 min",
    thumbnail_url: "https://img.youtube.com/vi/mDnmX5Q43l0/hqdefault.jpg",
    published_at: "2019-11-20T17:00:00Z",
    view_count: 8500000,
    summary: "Hesitation triggers the brain's defense mechanism to protect comfort. Moving physically within 5 seconds bypasses the prefrontal barrier.",
    tags: JSON.stringify(["habits", "action", "overthinking", "confidence", "psychology"])
  },
  {
    video_id: "dGZp4p8S5tE",
    channel_id: "UCtXKDgv1AVoG88PLl8nGXmw", // Talks at Google
    title: "Atomic Habits: An Easy & Proven Way to Build Good Habits",
    speaker: "James Clear",
    description: "James Clear speaks at Google about tiny behavioral changes, identity-based habits, and system design for exponential personal improvement.",
    duration_sec: 2820,
    duration_formatted: "47 min",
    thumbnail_url: "https://img.youtube.com/vi/dGZp4p8S5tE/hqdefault.jpg",
    published_at: "2019-02-14T19:00:00Z",
    view_count: 14000000,
    summary: "You do not rise to the level of your goals; you fall to the level of your systems. Tiny 1% daily optimizations compound into life-changing outcomes.",
    tags: JSON.stringify(["habits", "productivity", "psychology", "discipline", "personal growth"])
  }
];

function seedMockTalks() {
  const allTalks = [...MOCK_TALKS, ...CURATED_TALKS];
  console.log(`[Ingest] Seeding ${allTalks.length} curated talks across all channels...`);
  for (const talk of allTalks) {
    saveTalk(talk);
  }
  console.log(`[Ingest] Successfully inserted ${allTalks.length} curated talks into DB.`);
}

// Ingest a batch of talks from a channel via YouTube Data API
async function ingestChannel(channel, maxPages = 1) {
  const apiKey = getActiveKey();
  if (!apiKey) {
    console.log('[Ingest] YouTube API key not found. Skipping live fetch.');
    return 0;
  }

  const playlistId = channel.uploads_playlist_id;
  const channelName = channel.name;
  const minDuration = channel.min_duration_sec || 480;

  console.log(`\n======================================================`);
  console.log(`[Ingest] Starting sync for: ${channelName} (${channel.id})`);
  console.log(`[Ingest] Playlist: ${playlistId} | Min Duration: ${minDuration}s`);

  let pageToken = '';
  let pagesFetched = 0;
  let totalSaved = 0;

  while (pagesFetched < maxPages) {
    // 1. Fetch Playlist Items (Cost: 1 quota unit per 50 videos)
    let playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=50&key=${apiKey}`;
    if (pageToken) playlistUrl += `&pageToken=${pageToken}`;

    let playlistRes;
    try {
      playlistRes = await fetch(playlistUrl);
      totalQuotaUnitsUsed += 1;
    } catch (err) {
      console.error(`[Ingest] Network error fetching playlist for ${channelName}:`, err.message);
      break;
    }

    if (!playlistRes.ok) {
      const errText = await playlistRes.text();
      console.error(`[Ingest] Playlist API error (${playlistRes.status}):`, errText);
      if (playlistRes.status === 429 || playlistRes.status === 403) {
        rotateKey();
      }
      break;
    }

    const playlistData = await playlistRes.json();
    const items = playlistData.items || [];
    if (items.length === 0) break;

    const videoIds = items.map(i => i.contentDetails?.videoId).filter(Boolean);
    if (videoIds.length === 0) break;

    // 2. Fetch Video Details in Batch (Cost: 1 quota unit per 50 videos)
    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoIds.join(',')}&key=${apiKey}`;
    let videosRes;
    try {
      videosRes = await fetch(videosUrl);
      totalQuotaUnitsUsed += 1;
    } catch (err) {
      console.error(`[Ingest] Network error fetching video details:`, err.message);
      break;
    }

    if (!videosRes.ok) {
      console.error(`[Ingest] Video details API error (${videosRes.status})`);
      break;
    }

    const videosData = await videosRes.json();
    const videoDetails = videosData.items || [];

    // 3. Process, Filter & Save
    for (const v of videoDetails) {
      const durationStr = v.contentDetails?.duration;
      const durationSec = getDurationSeconds(durationStr);

      // Discard videos shorter than the channel's minimum duration threshold (Shorts filter)
      if (durationSec < minDuration) {
        continue;
      }

      const rawTitle = v.snippet?.title || '';
      const { speaker, title } = parseSpeakerAndTitle(rawTitle, channelName);
      const description = v.snippet?.description || '';
      const thumbnailUrl = v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url;
      const viewCount = parseInt(v.statistics?.viewCount || '0', 10);
      const publishedAt = v.snippet?.publishedAt;

      // Extract basic tags from category hint & title keywords
      const categoryTags = (channel.category_hint || '').split(',').map(s => s.trim().toLowerCase());
      const tagsJson = JSON.stringify(categoryTags);

      const talkRecord = {
        video_id: v.id,
        channel_id: channel.id,
        title: title || rawTitle,
        speaker: speaker,
        description: description.slice(0, 800), // Cap description
        duration_sec: durationSec,
        duration_formatted: parseDuration(durationStr),
        thumbnail_url: thumbnailUrl,
        published_at: publishedAt,
        view_count: viewCount,
        summary: description ? description.slice(0, 250) + "..." : "A featured long-form talk.",
        tags: tagsJson
      };

      saveTalk(talkRecord);
      totalSaved++;
    }

    console.log(`[Ingest] Page ${pagesFetched + 1}: processed ${videoDetails.length} videos, saved ${totalSaved} valid talks.`);
    pageToken = playlistData.nextPageToken;
    pagesFetched++;
    if (!pageToken) break;
  }

  updateChannelSyncStmt.run(channel.id);
  return totalSaved;
}

// Main execution function
export async function runIngestion() {
  const isMockOnly = process.argv.includes('--mock') || youtubeKeys.length === 0;

  if (isMockOnly) {
    seedMockTalks();
  } else {
    console.log(`[Ingest] Found ${youtubeKeys.length} YouTube API keys.`);
    const channels = db.prepare('SELECT * FROM channels WHERE active = 1').all();
    
    // Check if user specified a max pages flag (e.g. `node scripts/ingest.js --pages 2`)
    const pagesArgIdx = process.argv.indexOf('--pages');
    const maxPages = pagesArgIdx !== -1 ? parseInt(process.argv[pagesArgIdx + 1], 10) || 1 : 1;

    let grandTotal = 0;
    for (const ch of channels) {
      const saved = await ingestChannel(ch, maxPages);
      grandTotal += saved;
    }
    console.log(`\n======================================================`);
    console.log(`[Ingest] Ingestion complete! Total talks saved: ${grandTotal}`);
    console.log(`[Ingest] Total YouTube Quota Units Consumed: ${totalQuotaUnitsUsed}`);
  }

  const count = db.prepare('SELECT count(*) as total FROM talks').get();
  console.log(`[DB Status] Total talks currently stored in DB: ${count.total}`);
}

// Run if called from CLI
if (process.argv[1]?.endsWith('ingest.js')) {
  runIngestion()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Ingest] Fatal error during ingestion:', err);
      process.exit(1);
    });
}
