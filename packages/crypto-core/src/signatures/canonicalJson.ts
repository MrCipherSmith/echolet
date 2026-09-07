export function canonicalJson(obj: unknown): string {
  if (typeof obj !== "object" || obj === null) {
    return JSON.stringify(obj);
  }

  const sortedObj = Object.keys(obj)
    .sort()
    .reduce((result: Record<string, unknown>, key: string) => {
      if (key === "signature") return result;
      result[key] = (obj as Record<string, unknown>)[key];
      return result;
    }, {});

  return JSON.stringify(sortedObj);
}
