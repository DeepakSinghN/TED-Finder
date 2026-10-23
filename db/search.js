import db from './index.js';

// Sanitize user query into safe SQLite FTS5 syntax
export function sanitizeFtsQuery(rawQuery) {
  if (!rawQuery) return '';

  // Remove FTS5 operators and punctuation
  const cleaned = rawQuery
    .replace(/[^\w\s\d]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (cleaned.length === 0) return '';

  // Match prefix for each word: "procrast* OR habit*"
  return cleaned.map(w => `"${w}"*`).join(' OR ');
}

// Search Talks with FTS5 and Fallback Fuzzy Search
export function searchTalks({ query = '', channelId = '', limit = 12, offset = 0 } = {}) {
  const cleanQ = (query || '').trim();
  const ftsSyntax = sanitizeFtsQuery(cleanQ);

  let results = [];

  // 1. Try FTS5 Full-Text Match first
  if (ftsSyntax) {
    try {
      let sql = `
        SELECT 
          t.video_id, t.channel_id, t.title, t.speaker, t.description,
          t.duration_sec, t.duration_formatted, t.thumbnail_url,
          t.published_at, t.view_count, t.summary, t.tags,
          c.name AS channel_name,
          bm25(talks_fts) AS score
        FROM talks t
        JOIN channels c ON t.channel_id = c.id
        JOIN talks_fts ON t.video_id = talks_fts.video_id
        WHERE talks_fts MATCH @ftsQuery
      `;

      if (channelId) {
        sql += ` AND t.channel_id = @channelId`;
      }

      sql += ` ORDER BY score ASC, t.view_count DESC LIMIT @limit OFFSET @offset`;

      const stmt = db.prepare(sql);
      results = stmt.all({
        ftsQuery: ftsSyntax,
        channelId: channelId,
        limit: limit,
        offset: offset
      });
    } catch (err) {
      console.warn('[Search] FTS5 query failed, falling back to LIKE:', err.message);
    }
  }

  // 2. Fallback to LIKE if FTS gave no results or query had special characters
  if (results.length === 0 && cleanQ) {
    const likePattern = `%${cleanQ}%`;
    let sql = `
      SELECT 
        t.video_id, t.channel_id, t.title, t.speaker, t.description,
        t.duration_sec, t.duration_formatted, t.thumbnail_url,
        t.published_at, t.view_count, t.summary, t.tags,
        c.name AS channel_name,
        0 AS score
      FROM talks t
      JOIN channels c ON t.channel_id = c.id
      WHERE (t.title LIKE @likePattern OR t.speaker LIKE @likePattern OR t.tags LIKE @likePattern OR t.summary LIKE @likePattern)
    `;

    if (channelId) {
      sql += ` AND t.channel_id = @channelId`;
    }

    sql += ` ORDER BY t.view_count DESC, t.published_at DESC LIMIT @limit OFFSET @offset`;

    results = db.prepare(sql).all({
      likePattern,
      channelId,
      limit,
      offset
    });
  }

  // 3. If query was completely empty, return popular talks
  if (!cleanQ) {
    let sql = `
      SELECT 
        t.video_id, t.channel_id, t.title, t.speaker, t.description,
        t.duration_sec, t.duration_formatted, t.thumbnail_url,
        t.published_at, t.view_count, t.summary, t.tags,
        c.name AS channel_name,
        0 AS score
      FROM talks t
      JOIN channels c ON t.channel_id = c.id
    `;
    if (channelId) {
      sql += ` WHERE t.channel_id = @channelId`;
    }
    sql += ` ORDER BY t.view_count DESC, t.published_at DESC LIMIT @limit OFFSET @offset`;
    results = db.prepare(sql).all({ channelId, limit, offset });
  }

  // Format records for frontend consumption
  return results.map(r => ({
    videoId: r.video_id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    title: r.title,
    speaker: r.speaker || r.channel_name,
    description: r.description,
    duration: r.duration_formatted || `${Math.round(r.duration_sec / 60)} min`,
    durationSec: r.duration_sec,
    thumbnail: r.thumbnail_url,
    youtubeLink: `https://www.youtube.com/watch?v=${r.video_id}`,
    publishedAt: r.published_at,
    viewCount: r.view_count,
    reason: r.summary || (r.description ? r.description.slice(0, 150) + "..." : "A curated talk on this topic."),
    summary: r.summary,
    tags: safeJsonParse(r.tags, [])
  }));
}

// Fetch recent uploads across all or specific channel
export function getRecentTalks({ channelId = '', limit = 6 } = {}) {
  let sql = `
    SELECT 
      t.video_id, t.channel_id, t.title, t.speaker, t.description,
      t.duration_sec, t.duration_formatted, t.thumbnail_url,
      t.published_at, t.view_count, t.summary, t.tags,
      c.name AS channel_name
    FROM talks t
    JOIN channels c ON t.channel_id = c.id
  `;

  if (channelId) {
    sql += ` WHERE t.channel_id = @channelId`;
  }

  sql += ` ORDER BY t.published_at DESC LIMIT @limit`;

  const results = db.prepare(sql).all({ channelId, limit });

  return results.map(r => ({
    videoId: r.video_id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    title: r.title,
    speaker: r.speaker || r.channel_name,
    description: r.description,
    duration: r.duration_formatted || `${Math.round(r.duration_sec / 60)} min`,
    durationSec: r.duration_sec,
    thumbnail: r.thumbnail_url,
    youtubeLink: `https://www.youtube.com/watch?v=${r.video_id}`,
    publishedAt: r.published_at,
    viewCount: r.view_count,
    reason: r.summary || "Recently published talk.",
    summary: r.summary,
    tags: safeJsonParse(r.tags, [])
  }));
}

// Get active channels list for frontend filters
export function getActiveChannels() {
  return db.prepare('SELECT id, name, category_hint FROM channels WHERE active = 1 ORDER BY name ASC').all();
}

function safeJsonParse(val, fallback) {
  if (!val) return fallback;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}
