import type { HandoffIntent, HandoffPackageMode, HandoffTarget } from '../bridge/client';
import { createClaudePrompt, createCodexPrompt, type HandoffScope } from '../ai/prompts';
import type { ClipRecord, ClipSession } from '../types/session';
import {
  describeEvidenceProfile,
  normalizeClipForEvidence,
  type EvidenceProfile,
} from './evidence';

export type ClipBundleArtifacts = {
  context: Record<string, unknown> | null;
  annotations: Record<string, unknown> | null;
  promptClaude: string;
  promptCodex: string;
};

export function createClipBundleArtifacts(params: {
  scope: HandoffScope;
  target: HandoffTarget;
  intent: HandoffIntent;
  packageMode: HandoffPackageMode;
  evidenceProfile: EvidenceProfile;
  activeClip: ClipRecord;
  session: ClipSession;
}): ClipBundleArtifacts {
  const { scope, target, intent, packageMode, evidenceProfile, activeClip, session } = params;
  const includedClips = scope === 'session' ? session.clips : [activeClip];
  const normalizedActiveClip = normalizeClipForEvidence(activeClip, evidenceProfile);
  const normalizedClips = includedClips.map((clip) => normalizeClipForEvidence(clip, evidenceProfile));

  const context =
    packageMode === 'packet'
      ? {
          bundleVersion: 1,
          evidenceProfile,
          profileDescription: describeEvidenceProfile(evidenceProfile),
          target,
          intent,
          scope,
          session: {
            id: session.id,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            clipCount: session.clips.length,
            includedClipIds: includedClips.map((clip) => clip.id),
            activeClipId: activeClip.id,
          },
          activeClip: normalizedActiveClip,
          clips: normalizedClips,
        }
      : null;

  const annotations =
    packageMode === 'packet'
      ? {
          scope,
          evidenceProfile,
          activeClipId: activeClip.id,
          clips: includedClips.map((clip) => ({
            clipId: clip.id,
            title: clip.title,
            note: clip.note,
            annotations: clip.annotations,
          })),
        }
      : null;

  return {
    context,
    annotations,
    promptClaude: createClaudePrompt({
      scope,
      target,
      intent,
      packageMode,
      evidenceProfile,
      activeClip: normalizedActiveClip,
      session,
    }),
    promptCodex: createCodexPrompt({
      scope,
      target,
      intent,
      packageMode,
      evidenceProfile,
      activeClip: normalizedActiveClip,
      session,
    }),
  };
}
