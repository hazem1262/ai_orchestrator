CREATE VIRTUAL TABLE `events_fts` USING fts5(`text`, `search_input`, content='events', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `events_fts_ai` AFTER INSERT ON `events` WHEN new.kind NOT IN ('tool_result', 'thinking') BEGIN
  INSERT INTO events_fts(rowid, text, search_input) VALUES (new.id, new.text, new.search_input);
END;
--> statement-breakpoint
CREATE TRIGGER `events_fts_ad` AFTER DELETE ON `events` WHEN old.kind NOT IN ('tool_result', 'thinking') BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, search_input) VALUES ('delete', old.id, old.text, old.search_input);
END;
--> statement-breakpoint
CREATE TRIGGER `events_fts_au` AFTER UPDATE OF text, search_input ON `events` WHEN old.kind NOT IN ('tool_result', 'thinking') BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, search_input) VALUES ('delete', old.id, old.text, old.search_input);
  INSERT INTO events_fts(rowid, text, search_input) VALUES (new.id, new.text, new.search_input);
END;
