import { api, apiCall } from './api';

/**
 * What setup is made of, read from the API. Shared by the guided setup, Services
 * and Settings, so every page shows the same state and the same forms.
 */

export interface SetupStep {
  id: 'github' | 'alerts' | 'slack' | 'model_key' | 'service';
  label: string;
  status: 'done' | 'todo' | 'attention';
  detail: string | null;
}

export interface Setup {
  steps: SetupStep[];
  complete: boolean;
  attention: boolean;
  plan: {
    plan: { id: string; name: string };
    services: { used: number; limit: number };
    incidentsThisMonth: { used: number; limit: number };
    includedModelUsd: number | null;
  };
  testIncident: { status: string; error: string | null; at: string } | null;
}

export interface Installation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  suspendedAt: string | null;
  removedAt: string | null;
  settingsUrl: string | null;
}

export interface AvailableRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  picked: boolean;
}

export interface PickedRepo {
  id: string;
  fullName: string;
  defaultBranch: string;
}

export interface Channel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

export interface IntegrationStatus {
  configured: boolean;
  baseUrl?: string | null;
  config?: Record<string, unknown> | null;
  verifiedAt?: string | null;
  lastError?: string | null;
  keys: { kind: string; last4: string }[];
}

export interface Integrations {
  github: { installations: { id: string; accountLogin: string }[] };
  slack: { teamId: string; teamName: string } | null;
  datadog: IntegrationStatus;
  sentry: IntegrationStatus;
  notion: IntegrationStatus;
  resend: IntegrationStatus;
  anthropic: IntegrationStatus;
}

export const loadSetup = () => api<Setup>('/api/onboarding');
export const loadIntegrations = () => api<Integrations>('/api/integrations');
export const loadInstallations = async () => (await api<{ installations: Installation[] }>('/api/github/installations')).installations;
export const loadPickedRepositories = async () => (await api<{ repositories: PickedRepo[] }>('/api/repositories')).repositories;
/** A refusal (no GitHub App, no installation) is part of what the picker shows, so it is returned, not thrown. */
export const loadAvailableRepositories = () => apiCall<{ repositories: AvailableRepo[] }>('/api/github/repositories');
export const loadChannels = () => apiCall<{ channels: Channel[] }>('/api/slack/channels');
