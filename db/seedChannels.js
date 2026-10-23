import db, { initDatabase } from './index.js';

export const CHANNELS_SEED = [
  {
    id: 'UCAuUUnT6oDeKwE6v1NGQxug',
    name: 'TED',
    category_hint: 'general, inspiration, science, human nature',
    min_duration_sec: 480 // 8 minutes
  },
  {
    id: 'UCsT0YIqwnpJCM-mx7-gSA4Q',
    name: 'TEDx Talks',
    category_hint: 'grassroots, personal growth, diverse ideas',
    min_duration_sec: 480
  },
  {
    id: 'UC3eNlJKuJzJfNQzLphGZW7w',
    name: 'Stanford',
    category_hint: 'leadership, innovation, academics, science',
    min_duration_sec: 600 // 10 minutes
  },
  {
    id: 'UCtXKDgv1AVoG88PLl8nGXmw',
    name: 'Talks at Google',
    category_hint: 'authors, tech, leadership, creativity',
    min_duration_sec: 600
  },
  {
    id: 'UCxIJaCMEptJjxmmQgGFsnCg',
    name: 'Y Combinator',
    category_hint: 'startups, entrepreneurship, building products',
    min_duration_sec: 600
  },
  {
    id: 'UCWo4IA01TXzBeGJJKWHOG9g',
    name: 'Harvard Business Review',
    category_hint: 'business strategy, career growth, management',
    min_duration_sec: 480
  },
  {
    id: 'UCEBb1b_L6zDS3xTUrIALZOw',
    name: 'Big Think',
    category_hint: 'philosophy, science, psychology, future',
    min_duration_sec: 360 // 6 minutes (Big think talks are punchy)
  },
  {
    id: 'UCJIfeSCssxSC_Dhc5s7woww',
    name: 'Lex Fridman',
    category_hint: 'deep tech, AI, philosophy, long-form conversation',
    min_duration_sec: 900 // 15 minutes
  }
];

export function getUploadsPlaylistId(channelId) {
  if (channelId.startsWith('UC')) {
    return 'UU' + channelId.slice(2);
  }
  return channelId;
}

export function seedChannels() {
  initDatabase();

  const insertStmt = db.prepare(`
    INSERT INTO channels (id, name, uploads_playlist_id, category_hint, min_duration_sec, active)
    VALUES (@id, @name, @uploads_playlist_id, @category_hint, @min_duration_sec, 1)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      uploads_playlist_id = excluded.uploads_playlist_id,
      category_hint = excluded.category_hint,
      min_duration_sec = excluded.min_duration_sec;
  `);

  const insertMany = db.transaction((channels) => {
    for (const ch of channels) {
      insertStmt.run({
        id: ch.id,
        name: ch.name,
        uploads_playlist_id: getUploadsPlaylistId(ch.id),
        category_hint: ch.category_hint,
        min_duration_sec: ch.min_duration_sec
      });
    }
  });

  insertMany(CHANNELS_SEED);
  console.log(`[DB] Successfully seeded ${CHANNELS_SEED.length} verified channels.`);
}

// Auto-run if executed directly via `node db/seedChannels.js`
if (process.argv[1]?.endsWith('seedChannels.js')) {
  seedChannels();
  const channels = db.prepare('SELECT id, name, uploads_playlist_id, category_hint FROM channels').all();
  console.table(channels);
}
