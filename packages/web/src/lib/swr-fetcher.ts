'use client';

export async function jsonFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${url} returned ${res.status}${text ? `: ${text}` : ''}`);
  }
  return (await res.json()) as T;
}
