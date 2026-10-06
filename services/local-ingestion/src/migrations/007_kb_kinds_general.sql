-- Seed kinds move from tech-specific to general learning kinds.
UPDATE kb_entries SET kind = CASE kind
  WHEN '算法' THEN '方法'
  WHEN '模型' THEN '工具/资源' WHEN '论文' THEN '工具/资源' WHEN '工具' THEN '工具/资源' WHEN '库与框架' THEN '工具/资源'
  WHEN '设计模式' THEN '技巧' WHEN '最佳实践' THEN '技巧'
  ELSE kind END
WHERE kind IN ('算法','模型','论文','工具','库与框架','设计模式','最佳实践');
