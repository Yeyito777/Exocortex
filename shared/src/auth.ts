/**
 * Shared auth metadata helpers.
 */

import type { ProviderAuthInfo } from "./protocol";

export function createEmptyProviderAuthInfo(): ProviderAuthInfo {
  return {
    configured: false,
    authenticated: false,
    status: "not_logged_in",
    email: null,
    displayName: null,
    organizationName: null,
    organizationType: null,
    organizationRole: null,
    workspaceRole: null,
    subscriptionType: null,
    rateLimitTier: null,
    scopes: [],
    expiresAt: null,
    updatedAt: null,
    source: null,
  };
}
