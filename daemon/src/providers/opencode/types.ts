export interface OpenCodeModelsResponse {
  object?: "list";
  data?: Array<{
    id?: string;
    object?: string;
    owned_by?: string;
  }>;
}
