-- Entry notes pinned to a body section (`<!-- section:<id> -->`, 17); NULL = whole-entry note.
ALTER TABLE notes ADD COLUMN anchor TEXT;
