import dotenv from 'dotenv';
import db from '../db/index.js';
import { saveTalk } from './ingest.js';
import { parseDuration, getDurationSeconds, parseSpeakerAndTitle } from '../db/utils.js';

dotenv.config();

const rawKeys = process.env.YOUTUBE_API_KEYS || process.env.YOUTUBE_API_KEY || '';
const cleanKey = (k) => k?.trim().replace(/^['"]|['"]$/g, '').trim();
const isPlaceholder = (k) => !k || k.toUpperCase().includes('YOUR_') || k.includes('api_key');
const youtubeKeys = rawKeys.split(',').map(cleanKey).filter(Boolean).filter(k => !isPlaceholder(k));

function extractXmlTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? match[1].trim() : '';
}

// Parse YouTube RSS feed items
function parseRssFeed(xmlText) {
  const entries = [];
  const entryMatches = xmlText.match(/<entry>([\s\S]*?)<\/entry>/gi) || [];

  for (const entryXml of entryMatches) {
    const videoId = extractXmlTag(entryXml, 'yt:videoId');
    const title = extractXmlTag(entryXml, 'title');
    const publishedAt = extractXmlTag(entryXml, 'published');
    const description = extractXmlTag(entryXml, 'media:description');

    if (videoId && title) {
      entries.push({
        videoId,
        title,
        publishedAt,
        description
      });
    }
  }

  return entries;
}

// Sync latest videos from RSS feeds (100% Free / Zero API Quota)
export async function syncChannelsRss() {
  console.log('[RSS Sync] Starting YouTube RSS Feed check for all active channels...');
  const channels = db.prepare('SELECT * FROM channels WHERE active = 1').all();
  const existingVideoIdsStmt = db.prepare('SELECT video_id FROM talks WHERE video_id = ?');

  let newVideosCount = 0;

  for (const channel of channels) {
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`;
    
    try {
      const res = await fetch(rssUrl);
      if (!res.ok) {
        console.warn(`[RSS Sync] Channel ${channel.name} returned status ${res.status}`);
        continue;
      }

      const xmlText = await res.text();
      const entries = parseRssFeed(xmlText);
      const newEntries = entries.filter(e => !existingVideoIdsStmt.get(e.videoId));

      if (newEntries.length === 0) {
        // No new uploads
        continue;
      }

      console.log(`[RSS Sync] Found ${newEntries.length} new potential videos for ${channel.name}`);

      // If YouTube API key is available, fetch exact durations in batch
      if (youtubeKeys.length > 0) {
        const videoIds = newEntries.map(e => e.videoId).join(',');
        const apiKey = youtubeKeys[0];
        const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet,statistics&id=${videoIds}&key=${apiKey}`;
        const vRes = await fetch(vUrl);

        if (vRes.ok) {
          const vData = await vRes.json();
          const items = vData.items || [];

          for (const item of items) {
            const durationStr = item.contentDetails?.duration;
            const durationSec = getDurationSeconds(durationStr);

            if (durationSec < (channel.min_duration_sec || 480)) {
              continue; // Skip Shorts
            }

            const { speaker, title } = parseSpeakerAndTitle(item.snippet.title, channel.name);
            const viewCount = parseInt(item.statistics?.viewCount || '0', 10);

            saveTalk({
              video_id: item.id,
              channel_id: channel.id,
              title: title,
              speaker: speaker,
              description: (item.snippet.description || '').slice(0, 800),
              duration_sec: durationSec,
              duration_formatted: parseDuration(durationStr),
              thumbnail_url: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url,
              published_at: item.snippet.publishedAt,
              view_count: viewCount,
              summary: (item.snippet.description || '').slice(0, 250) + "...",
              tags: JSON.stringify((channel.category_hint || '').split(',').map(s => s.trim()))
            });

            newVideosCount++;
          }
        }
      } else {
        // Zero API Key Mode: Ingest directly from RSS metadata
        for (const item of newEntries) {
          if (item.title.toLowerCase().includes('#shorts') || item.title.toLowerCase().includes('shorts')) {
            continue;
          }
          const { speaker, title } = parseSpeakerAndTitle(item.title, channel.name);
          const durationSec = 900; // Default estimated 15 min

          saveTalk({
            video_id: item.videoId,
            channel_id: channel.id,
            title: title,
            speaker: speaker,
            description: (item.description || '').slice(0, 800),
            duration_sec: durationSec,
            duration_formatted: '15 min',
            thumbnail_url: `https://img.youtube.com/vi/${item.videoId}/hqdefault.jpg`,
            published_at: item.publishedAt,
            view_count: 100000,
            summary: (item.description || '').slice(0, 250) + "...",
            tags: JSON.stringify((channel.category_hint || '').split(',').map(s => s.trim()))
          });

          newVideosCount++;
        }
      }

      db.prepare('UPDATE channels SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?').run(channel.id);
    } catch (err) {
      console.error(`[RSS Sync] Failed checking RSS for ${channel.name}:`, err.message);
    }
  }

  console.log(`[RSS Sync] Finished! ${newVideosCount} new talks ingested into DB.`);
}

if (process.argv[1]?.endsWith('rssSync.js')) {
  syncChannelsRss()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[RSS Sync] Fatal error:', err);
      process.exit(1);
    });
}
