import {
  integrationDeliveryRecordSchema,
  type IntegrationDeliveryRecord,
  type IntegrationTarget,
} from './types';

const STORAGE_PREFIX = '__llmclip_delivery';

export function deliveryKey(clipId: string, target: IntegrationTarget): string {
  return `${STORAGE_PREFIX}_${clipId}_${target}`;
}

export async function saveDelivery(record: IntegrationDeliveryRecord): Promise<IntegrationDeliveryRecord> {
  const parsed = integrationDeliveryRecordSchema.parse(record);
  await chrome.storage.local.set({
    [deliveryKey(parsed.clipId, parsed.target)]: parsed,
  });
  return parsed;
}

export async function getDelivery(
  clipId: string,
  target: IntegrationTarget,
): Promise<IntegrationDeliveryRecord | null> {
  const key = deliveryKey(clipId, target);
  const result = await chrome.storage.local.get(key);
  const record = result[key];
  return record ? integrationDeliveryRecordSchema.parse(record) : null;
}

export async function listDeliveriesForClip(clipId: string): Promise<IntegrationDeliveryRecord[]> {
  const result = await chrome.storage.local.get(null);
  return Object.entries(result)
    .filter(([key]) => key.startsWith(`${STORAGE_PREFIX}_${clipId}_`))
    .map(([, value]) => integrationDeliveryRecordSchema.parse(value));
}
