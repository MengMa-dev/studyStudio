-- S24: entry kinds become free-form Chinese names (14 A1).
UPDATE kb_entries SET kind = CASE kind
  WHEN 'concept' THEN '概念' WHEN 'method' THEN '方法' WHEN 'algorithm' THEN '算法'
  WHEN 'model' THEN '模型' WHEN 'paper' THEN '论文' WHEN 'tool' THEN '工具'
  WHEN 'library' THEN '库与框架' WHEN 'pattern' THEN '设计模式' WHEN 'practice' THEN '最佳实践'
  ELSE '其他' END
WHERE kind IS NULL OR kind IN ('concept','method','algorithm','model','paper','tool','library','pattern','practice','other');
