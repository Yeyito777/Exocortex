export interface AnthropicAssistantProviderData {
  anthropic: {
    sessionId?: string;
  };
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
}

export interface StoredAnthropicAuth {
  cli: {
    authenticated: boolean;
    version: string | null;
    authMethod: string | null;
    subscriptionType: string | null;
  };
  profile: {
    accountUuid: string;
    email: string;
    displayName: string | null;
    organizationUuid: string | null;
    organizationName: string | null;
    organizationType: string | null;
    organizationRole: string | null;
    workspaceRole: string | null;
  } | null;
  updatedAt: string;
}
