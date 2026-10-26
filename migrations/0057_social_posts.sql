CREATE TABLE social_posts (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  tweet_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','daily')),
  created_at INTEGER NOT NULL
);
CREATE INDEX social_posts_created ON social_posts(created_at);
