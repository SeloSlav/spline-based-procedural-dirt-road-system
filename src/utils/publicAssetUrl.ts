export function publicAssetUrl(path: string): string {
  const relativePath = path.replace(/^\/+/, '');
  return `${import.meta.env.BASE_URL}${relativePath}`;
}
