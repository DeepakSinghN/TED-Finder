import 'dotenv/config';
import crypto from 'crypto';
import db from './index.js';
import { searchTalks } from './search.js';

// Clean and extract API keys dynamically
function getApiKeys() {
  const rawGeminiKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  const rawOpenRouterKey = process.env.OPENROUTER_API_KEY || '';
  const cleanKey = (k) => k?.trim().replace(/^['"]|['"]$/g, '').trim();
  const isPlaceholder = (k) => !k || k.toUpperCase().includes('YOUR_') || k.includes('api_key');

  const allKeys = [
    ...new Set([
      ...rawOpenRouterKey.split(',').map(cleanKey),
      ...rawGeminiKeys.split(',').map(cleanKey)
    ])
  ].filter(Boolean).filter(k => !isPlaceholder(k));

  return {
    openRouterKeys: allKeys.filter(k => k.startsWith('sk-or-')),
    googleKeys: allKeys.filter(k => !k.startsWith('sk-or-'))
  };
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

// 1. Retrieve Candidate Talks from DB
export function getCandidateTalksForGoal(goal) {
  // First search DB with the user's goal
  let candidates = searchTalks({ query: goal, limit: 25 });

  // If fewer than 10 candidates found, backfill with popular high-rated talks
  if (candidates.length < 10) {
    const popular = searchTalks({ query: '', limit: 15 });
    const seen = new Set(candidates.map(c => c.videoId));
    for (const p of popular) {
      if (!seen.has(p.videoId)) {
        candidates.push(p);
        seen.add(p.videoId);
      }
    }
  }

  return candidates;
}

// 2. Call AI (OpenRouter or Google Gemini) to select & structure 5 talks
async function generatePathWithAI(goal, candidates) {
  // Use top 8 candidates to keep payload compact and latency low
  const compactCandidates = candidates.slice(0, 8).map(c => ({
    id: c.videoId,
    title: c.title,
    speaker: c.speaker,
    duration: c.duration,
    summary: (c.summary || '').slice(0, 100)
  }));

  const prompt = `You are an expert executive coach.
Goal: "${goal}"

Candidate Talks:
${JSON.stringify(compactCandidates, null, 2)}

Select 5 talks from above and create a progressive 5-step curriculum.
Respond ONLY with raw valid JSON:
{
  "title": "Inspiring Roadmap Title",
  "overview": "1-2 sentence overview of the journey.",
  "items": [
    {
      "video_id": "Exact id from list",
      "why_this_talk": "1 sentence why this talk is in this position",
      "key_takeaway": "1 sentence core insight",
      "action_step": "1 concrete habit to do this week"
    }
  ]
}`;

  const { openRouterKeys, googleKeys } = getApiKeys();

  // Option A: Try OpenRouter models if key is present
  if (openRouterKeys.length > 0) {
    const key = openRouterKeys[0];
    const model = 'openrouter/free';
    try {
      console.log(`[Path Generator] Querying OpenRouter (${model}) with 5s timeout...`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1000
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        let text = data.choices?.[0]?.message?.content?.trim() || '';
        if (text) {
          text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
          const parsed = JSON.parse(text);
          if (parsed.items && Array.isArray(parsed.items) && parsed.items.length >= 3) {
            console.log(`[Path Generator] Successfully generated path using OpenRouter!`);
            return parsed;
          }
        }
      } else {
        console.warn(`[Path Generator] OpenRouter returned ${response.status}`);
      }
    } catch (err) {
      console.warn(`[Path Generator] OpenRouter response skipped (${err.message}). Using instant smart curriculum engine.`);
    }
  }

  // Option B: Try Google Gemini direct endpoints if Google key is present
  if (googleKeys.length > 0) {
    const models = ["gemini-2.0-flash", "gemini-1.5-flash"];
    for (const key of googleKeys) {
      for (const model of models) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);

          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: "application/json" }
            }),
            signal: controller.signal
          });
          clearTimeout(timeout);

          if (!response.ok) continue;

          const data = await response.json();
          let text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
          text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
          return JSON.parse(text);
        } catch (err) {
          console.warn(`[Path Generator] Gemini ${model} skipped:`, err.message);
        }
      }
    }
  }

  return null;
}

// 3. Fallback deterministic path builder if AI is busy or times out
function generateMockPath(goal, candidates) {
  const selected = candidates.slice(0, Math.min(5, candidates.length));
  const goalClean = goal.charAt(0).toUpperCase() + goal.slice(1);

  const stepThemes = [
    {
      why: (s, g) => `Step 1 (Mindset Shift): Build the foundational psychological models for ${g}.`,
      action: (s) => `Spend 10 minutes writing down your core baseline and one key takeaway from ${s}.`
    },
    {
      why: (s, g) => `Step 2 (Overcoming Friction): Eliminate hesitation and resistance in your daily workflow.`,
      action: (s) => `Apply ${s}'s primary technique immediately when encountering friction this week.`
    },
    {
      why: (s, g) => `Step 3 (Building Systems): Design sustainable daily habits that compound over time.`,
      action: (s) => `Pick one micro-habit from this talk and track it daily for the next 7 days.`
    },
    {
      why: (s, g) => `Step 4 (Perseverance & Grit): Push through plateaus with proven resilience strategies.`,
      action: (s) => `Reflect on your current obstacles and create an "if-then" plan based on ${s}'s insights.`
    },
    {
      why: (s, g) => `Step 5 (Mastery & Compounding): Execute with high conviction and strategic focus.`,
      action: (s) => `Schedule a weekly 15-minute review to evaluate progress and refine your trajectory.`
    }
  ];

  return {
    title: `Mastering ${goalClean}: 5-Step Action Roadmap`,
    overview: `A progressive, high-impact curriculum of world-class talks sequencing mindset, friction elimination, system building, and long-term execution for ${goal}.`,
    items: selected.map((talk, idx) => {
      const theme = stepThemes[idx] || stepThemes[0];
      return {
        video_id: talk.videoId,
        why_this_talk: theme.why(talk.speaker, goalClean),
        key_takeaway: talk.summary || `Compounding small deliberate improvements leads to outsized mastery over time.`,
        action_step: theme.action(talk.speaker)
      };
    })
  };
}

// 4. Main Service: Generate, Validate, and Save Learning Path
export async function createLearningPath({ goal, userId = null }) {
  const cleanGoal = (goal || '').trim().slice(0, 200);
  if (!cleanGoal) {
    throw new Error('Goal text is required to generate a learning path.');
  }

  // 1. Retrieve candidates from our DB
  const candidates = getCandidateTalksForGoal(cleanGoal);
  const candidateMap = new Map(candidates.map(c => [c.videoId, c]));

  // 2. Call AI or Mock Generator
  let aiPath = await generatePathWithAI(cleanGoal, candidates);
  if (!aiPath || !aiPath.items || aiPath.items.length < 3) {
    aiPath = generateMockPath(cleanGoal, candidates);
  }

  // 3. Hard Validation: Discard any video_id not in DB
  const validItems = [];
  const seenIds = new Set();

  for (const item of aiPath.items) {
    if (candidateMap.has(item.video_id) && !seenIds.has(item.video_id)) {
      validItems.push({
        ...item,
        talk: candidateMap.get(item.video_id)
      });
      seenIds.add(item.video_id);
    }
    if (validItems.length >= 7) break;
  }

  // If AI picked fewer than 4 valid talks, fill from candidates
  if (validItems.length < 4) {
    for (const c of candidates) {
      if (!seenIds.has(c.videoId)) {
        validItems.push({
          video_id: c.videoId,
          why_this_talk: `Essential perspective by ${c.speaker} reinforcing key skills.`,
          key_takeaway: c.summary || 'Consistent deliberate practice accelerates mastery.',
          action_step: `Review ${c.title} and apply one key insight immediately.`,
          talk: c
        });
        seenIds.add(c.videoId);
      }
      if (validItems.length >= 5) break;
    }
  }

  // 4. Save to Database inside a Transaction
  const pathId = crypto.randomUUID();
  const slugSuffix = crypto.randomBytes(3).toString('hex');
  const slug = `${slugify(aiPath.title || cleanGoal)}-${slugSuffix}`;

  const insertPathStmt = db.prepare(`
    INSERT INTO learning_paths (id, user_id, goal_text, title, overview, slug, is_public)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);

  const insertItemStmt = db.prepare(`
    INSERT INTO path_items (id, path_id, position, video_id, why_this_talk, key_takeaway, action_step, is_watched)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `);

  db.transaction(() => {
    insertPathStmt.run(pathId, userId, cleanGoal, aiPath.title, aiPath.overview, slug);

    validItems.forEach((item, index) => {
      const itemId = crypto.randomUUID();
      insertItemStmt.run(
        itemId,
        pathId,
        index + 1,
        item.video_id,
        item.why_this_talk,
        item.key_takeaway,
        item.action_step
      );
    });
  })();

  return getLearningPathBySlug(slug);
}

// 5. Fetch a Path by Slug (For Public View & Interactive Tracker)
export function getLearningPathBySlug(slug) {
  const path = db.prepare(`
    SELECT id, user_id, goal_text, title, overview, slug, is_public, created_at
    FROM learning_paths
    WHERE slug = ?
  `).get(slug);

  if (!path) return null;

  const items = db.prepare(`
    SELECT 
      pi.id AS item_id, pi.position, pi.why_this_talk, pi.key_takeaway, pi.action_step, pi.is_watched,
      t.video_id, t.title, t.speaker, t.duration_formatted, t.duration_sec,
      t.thumbnail_url, t.view_count, t.summary, t.tags,
      c.name AS channel_name
    FROM path_items pi
    JOIN talks t ON pi.video_id = t.video_id
    JOIN channels c ON t.channel_id = c.id
    WHERE pi.path_id = ?
    ORDER BY pi.position ASC
  `).all(path.id);

  const formattedItems = items.map(item => ({
    itemId: item.item_id,
    position: item.position,
    whyThisTalk: item.why_this_talk,
    keyTakeaway: item.key_takeaway,
    actionStep: item.action_step,
    isWatched: Boolean(item.is_watched),
    talk: {
      videoId: item.video_id,
      title: item.title,
      speaker: item.speaker || item.channel_name,
      channelName: item.channel_name,
      duration: item.duration_formatted || `${Math.round(item.duration_sec / 60)} min`,
      durationSec: item.duration_sec,
      thumbnail: item.thumbnail_url,
      youtubeLink: `https://www.youtube.com/watch?v=${item.video_id}`,
      summary: item.summary
    }
  }));

  const totalDurationSec = items.reduce((acc, it) => acc + (it.duration_sec || 0), 0);
  const watchedCount = items.filter(it => it.is_watched).length;

  return {
    ...path,
    totalTalks: items.length,
    watchedCount,
    progressPercentage: Math.round((watchedCount / (items.length || 1)) * 100),
    totalDurationFormatted: `${Math.round(totalDurationSec / 60)} min`,
    items: formattedItems
  };
}

// 6. Toggle watched status of an item
export function toggleItemWatched(itemId, isWatched) {
  const stmt = db.prepare(`UPDATE path_items SET is_watched = ? WHERE id = ?`);
  const result = stmt.run(isWatched ? 1 : 0, itemId);
  return result.changes > 0;
}
