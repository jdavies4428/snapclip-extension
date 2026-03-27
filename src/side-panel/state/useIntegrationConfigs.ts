import { useEffect, useState } from 'react';
import {
  clearIntegrationConfig,
  getAllIntegrationConfigs,
  getIntegrationConnectionSummaries,
  setIntegrationConfig,
} from '../../shared/integrations/config';
import type {
  IntegrationConfigMap,
  IntegrationConnectionSummary,
  IntegrationTarget,
} from '../../shared/integrations/types';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The integration settings could not be loaded.';
}

export function useIntegrationConfigs(enabled = true) {
  const [configs, setConfigs] = useState<IntegrationConfigMap | null>(null);
  const [summaries, setSummaries] = useState<IntegrationConnectionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    if (!enabled) {
      return;
    }

    setIsLoading(true);
    try {
      const [nextConfigs, nextSummaries] = await Promise.all([
        getAllIntegrationConfigs(),
        getIntegrationConnectionSummaries(),
      ]);
      setConfigs(nextConfigs);
      setSummaries(nextSummaries);
      setError('');
    } catch (refreshError) {
      setError(toErrorMessage(refreshError));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [enabled]);

  async function saveTargetConfig<Target extends IntegrationTarget>(
    target: Target,
    config: Partial<IntegrationConfigMap[Target]>,
  ) {
    setIsSaving(true);
    try {
      await setIntegrationConfig(target, config);
      await refresh();
      setError('');
    } catch (saveError) {
      setError(toErrorMessage(saveError));
      throw saveError;
    } finally {
      setIsSaving(false);
    }
  }

  async function clearTargetConfig(target: IntegrationTarget) {
    setIsSaving(true);
    try {
      await clearIntegrationConfig(target);
      await refresh();
      setError('');
    } catch (clearError) {
      setError(toErrorMessage(clearError));
      throw clearError;
    } finally {
      setIsSaving(false);
    }
  }

  return {
    configs,
    summaries,
    isLoading,
    isSaving,
    error,
    refresh,
    saveTargetConfig,
    clearTargetConfig,
  };
}
