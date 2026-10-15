export const normalizeStringList = (value: unknown): string[] => {
  let items: unknown[];

  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      items = Array.isArray(parsed) ? parsed : [];
    } catch {
      items = [];
    }
  } else {
    items = [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(name);
  }
  return normalized;
};

export const serializeStringList = (value: unknown): string =>
  JSON.stringify(normalizeStringList(value));
