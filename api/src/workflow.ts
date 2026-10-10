export function nextWebhookRevision(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 &&
      Number(value) < Number.MAX_SAFE_INTEGER
    ? Number(value) + 1
    : 1;
}
