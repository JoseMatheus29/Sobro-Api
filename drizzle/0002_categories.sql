-- Catálogo global de categorias (o mesmo do seed do app, db/seed.ts).
INSERT INTO "categories" ("id", "name", "icon", "color", "bg") VALUES
  ('food', 'Alimentação', 'restaurant', '#E67E22', 'rgba(230,126,34,0.12)'),
  ('transport', 'Transporte', 'directions-car', '#3161B2', 'rgba(49,97,178,0.12)'),
  ('leisure', 'Lazer', 'sports-esports', '#7998CD', 'rgba(121,152,205,0.12)'),
  ('health', 'Saúde', 'favorite', '#A83636', 'rgba(168,54,54,0.12)'),
  ('shopping', 'Shopping', 'shopping-bag', '#9B59B6', 'rgba(155,89,182,0.12)'),
  ('salary', 'Salário', 'account-balance', '#277F2B', 'rgba(39,127,43,0.12)'),
  ('invest', 'Investimento', 'trending-up', '#1ABC9C', 'rgba(26,188,156,0.12)'),
  ('transfer', 'Transferência', 'swap-horiz', '#718096', 'rgba(113,128,150,0.12)'),
  ('other', 'Outros', 'category', '#95A5A6', 'rgba(149,165,166,0.12)')
ON CONFLICT ("id") DO NOTHING;
