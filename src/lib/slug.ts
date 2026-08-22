// URL-safe slug for any Italian title or label. Mirrors the server-side
// helper in server/lib/ingest/parlamento/parseHelpers.ts so that the same
// string produces the same slug on both sides of the wire.

export function slugify(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}
