import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StoragePaths } from '../database/paths.js';

export class OverlayError extends Error {
  readonly statusCode = 400;
  readonly code = 'OVERLAY_ASSET_INVALID';
}

export const overlayLayouts = [
  'classic',
  'competition',
  'minimal',
  'rapid_fire',
  'neon',
  'studio',
  'ticker',
  'spotlight',
  'cards',
  'lower_third',
] as const;
export const overlaySettingsSchema = z.object({
  layout: z.enum(overlayLayouts).default('classic'),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#7dd3fc'),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#a78bfa'),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#020617'),
  panelColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0f172a'),
  panelOpacity: z.number().min(0).max(1).default(0.86),
  showPanelBackground: z.boolean().default(true),
  questionFontSize: z.number().int().min(24).max(120).default(52),
  choiceFontSize: z.number().int().min(16).max(72).default(30),
  choiceGap: z.number().int().min(8).max(64).default(20),
  contentScale: z.number().min(0.5).max(1.2).default(0.72),
  positionX: z.number().min(-50).max(50).default(0),
  positionY: z.number().min(-80).max(20).default(0),
  countdownStyle: z.enum(['ring', 'bar', 'badge']).default('ring'),
  eventTitle: z.string().trim().max(160).default(''),
  logoPath: z.string().max(300).nullable().default(null),
  backgroundImagePath: z.string().max(300).nullable().default(null),
  lowerThirdText: z.string().trim().max(240).default(''),
  customFontFamily: z.string().trim().max(100).default(''),
  participantBadgeMode: z.enum(['manual', 'rapid_fire']).default('manual'),
  participantBadgeParticipantId: z.string().uuid().nullable().default(null),
});

export type OverlaySettings = z.infer<typeof overlaySettingsSchema>;

export function getOverlaySettings(settings: Record<string, unknown>): OverlaySettings {
  const result = overlaySettingsSchema.safeParse(settings.overlay);
  return result.success ? result.data : overlaySettingsSchema.parse({});
}

export function updateOverlaySettings(current: Record<string, unknown>, input: unknown): OverlaySettings {
  const patch = z.object({
    layout: z.enum(overlayLayouts).optional(),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    panelColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    panelOpacity: z.number().min(0).max(1).optional(),
    showPanelBackground: z.boolean().optional(),
    questionFontSize: z.number().int().min(24).max(120).optional(),
    choiceFontSize: z.number().int().min(16).max(72).optional(),
    choiceGap: z.number().int().min(8).max(64).optional(),
    contentScale: z.number().min(0.5).max(1.2).optional(),
    positionX: z.number().min(-50).max(50).optional(),
    positionY: z.number().min(-80).max(20).optional(),
    countdownStyle: z.enum(['ring', 'bar', 'badge']).optional(),
    eventTitle: z.string().trim().max(160).optional(),
    logoPath: z.string().max(300).nullable().optional(),
    backgroundImagePath: z.string().max(300).nullable().optional(),
    lowerThirdText: z.string().trim().max(240).optional(),
    customFontFamily: z.string().trim().max(100).optional(),
    participantBadgeMode: z.enum(['manual', 'rapid_fire']).optional(),
    participantBadgeParticipantId: z.string().uuid().nullable().optional(),
  }).strict().parse(input);
  return overlaySettingsSchema.parse({ ...getOverlaySettings(current), ...patch });
}

const assetTypes: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/flac': '.flac',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'font/ttf': '.ttf',
};

function hasExpectedSignature(contentType: string, buffer: Buffer): boolean {
  if (contentType === 'audio/mpeg') return buffer.subarray(0, 3).toString() === 'ID3' || (buffer[0] === 255 && (buffer[1] & 224) === 224);
  if (contentType === 'audio/wav' || contentType === 'audio/x-wav') return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE';
  if (contentType === 'audio/ogg') return buffer.subarray(0, 4).toString() === 'OggS';
  if (contentType === 'audio/mp4') return buffer.subarray(4, 8).toString() === 'ftyp';
  if (contentType === 'audio/flac') return buffer.subarray(0, 4).toString() === 'fLaC';
  if (contentType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === 'image/jpeg') return buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (contentType === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (contentType === 'image/svg+xml') return /^\uFEFF?\s*(?:<!--[^]*?-->\s*)*<svg(?:\s|>)/i.test(buffer.toString('utf8', 0, 4096));
  if (contentType === 'font/woff') return buffer.subarray(0, 4).toString('ascii') === 'wOFF';
  if (contentType === 'font/woff2') return buffer.subarray(0, 4).toString('ascii') === 'wOF2';
  if (contentType === 'font/ttf') return buffer.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) || buffer.subarray(0, 4).toString('ascii') === 'true';
  return false;
}

export function saveOverlayAsset(paths: StoragePaths, input: unknown): { assetId: string; contentType: string } {
  const value = z.object({
    contentType: z.string().refine((type) => type in assetTypes, 'Unsupported asset type.'),
    data: z.string().min(1),
  }).strict().parse(input);
  const raw = value.data.replace(/^data:[^;]+;base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length > 7_000_000) {
    throw new OverlayError('Asset must be valid base64 and no larger than 5 MB.');
  }
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) throw new OverlayError('Asset must be between 1 byte and 5 MB.');
  if (!hasExpectedSignature(value.contentType, buffer)) throw new OverlayError('Asset content does not match its declared type.');
  const assetId = `${randomUUID()}${assetTypes[value.contentType]}`;
  const directory = path.join(paths.mediaDir, 'overlays');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, assetId), buffer, { flag: 'wx' });
  return { assetId, contentType: value.contentType };
}

export function readOverlayAsset(paths: StoragePaths, assetId: string): { data: Buffer; contentType: string } | null {
  if (!/^[0-9a-f-]{36}\.(png|jpg|webp|svg|woff|woff2|ttf|mp3|wav|ogg|m4a|flac)$/.test(assetId)) return null;
  const extension = path.extname(assetId);
  const contentType = Object.entries(assetTypes).find(([, value]) => value === extension)?.[0];
  if (!contentType) return null;
  try {
    return { data: fs.readFileSync(path.join(paths.mediaDir, 'overlays', assetId)), contentType };
  } catch {
    return null;
  }
}
